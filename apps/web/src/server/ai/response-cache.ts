import { sleep } from "@cubby/shared/retry";
import { sha256Hex } from "@cubby/shared/sha256";
import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";
import type { AiChatRequest } from "~/server/ai/run-feature";
import { getAiResponseCacheNamespace } from "~/server/cf-env";

const log = createLogger("ai-response-cache");

export const AI_RESPONSE_CACHE_BATCH_SIZE = 128;

const CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
const LEASE_MS = 90_000;
const MAX_VALUE_BYTES = 1_000_000;
const MAX_LOCAL_ENTRIES = 512;

export type ApplicationCacheStatus = "hit" | "miss" | "none";
const jsonSchema = z.json();
const jsonScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
type JsonValue = z.infer<typeof jsonSchema>;
export interface AiResponseCacheKeyInput {
  feature: string;
  model: string;
  promptVersion: string;
  input?: {
    state: string;
    questions: {
      selection: {
        type: "choice";
        instructions: string;
        criteria: Record<string, string>;
      };
    };
  };
  tier?: string;
  maxTokens?: number;
  effort?: string;
  request?: AiChatRequest;
}

interface CacheStore {
  readOrClaim(
    key: string,
    force: boolean,
  ):
    | Promise<
        | { kind: "hit"; value: string }
        | { kind: "busy" }
        | { kind: "claimed"; token: string }
      >
    | { kind: "hit"; value: string }
    | { kind: "busy" }
    | { kind: "claimed"; token: string };
  readOrClaimMany(
    requests: readonly { key: string; force: boolean }[],
  ): Promise<CacheClaim[]> | CacheClaim[];
  renew(key: string, token: string): Promise<boolean> | boolean;
  publish(
    key: string,
    token: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> | boolean;
  release(key: string, token: string): Promise<void> | void;
  invalidate(key: string, value: string): Promise<void> | void;
}

type CacheClaim = Awaited<ReturnType<CacheStore["readOrClaim"]>>;

type LocalRow = {
  value: string | null;
  expiresAt: number;
  token: string | null;
  leaseUntil: number;
};

class LocalCacheStore implements CacheStore {
  private rows = new Map<string, LocalRow>();

  readOrClaim(key: string, force: boolean) {
    const row = this.rows.get(key);
    const now = Date.now();
    if (row?.token && row.leaseUntil > now) return { kind: "busy" as const };
    if (!force && row?.value && row.expiresAt > now) {
      return { kind: "hit" as const, value: row.value };
    }
    const token = crypto.randomUUID();
    this.rows.set(key, {
      value: null,
      expiresAt: 0,
      token,
      leaseUntil: now + LEASE_MS,
    });
    while (this.rows.size > MAX_LOCAL_ENTRIES)
      this.rows.delete(this.rows.keys().next().value!);
    return { kind: "claimed" as const, token };
  }

  readOrClaimMany(requests: readonly { key: string; force: boolean }[]) {
    if (requests.length > AI_RESPONSE_CACHE_BATCH_SIZE)
      throw new Error(
        `AI response cache batch supports at most ${AI_RESPONSE_CACHE_BATCH_SIZE} keys, got ${requests.length}`,
      );
    return requests.map(({ key, force }) => this.readOrClaim(key, force));
  }

  renew(key: string, token: string) {
    const row = this.rows.get(key);
    if (row?.token !== token) return false;
    row.leaseUntil = Date.now() + LEASE_MS;
    return true;
  }

  publish(key: string, token: string, value: string, ttlMs: number) {
    const row = this.rows.get(key);
    if (row?.token !== token) return false;
    this.rows.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      token: null,
      leaseUntil: 0,
    });
    return true;
  }

  release(key: string, token: string) {
    if (this.rows.get(key)?.token === token) this.rows.delete(key);
  }

  invalidate(key: string, value: string) {
    if (this.rows.get(key)?.value === value) this.rows.delete(key);
  }
}

const localStore = new LocalCacheStore();

function canonical(value: JsonValue): JsonValue {
  if (jsonScalarSchema.safeParse(value).success) return value;
  if (Array.isArray(value)) return value.map(canonical);
  const record = z.record(z.string(), jsonSchema).parse(value);
  return Object.fromEntries(
    Object.entries(record)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

export async function aiResponseCacheKey(
  input: AiResponseCacheKeyInput,
): Promise<string | null> {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return null;
  }
  const parsed = jsonSchema.safeParse(JSON.parse(serialized));
  if (!parsed.success) return null;
  return sha256Hex(
    JSON.stringify(canonical({ version: 1, payload: parsed.data })),
  );
}

const cacheShard = (key: string) =>
  `shard-${parseInt(key.slice(0, 2), 16) % 64}`;

function cacheStore(key: string): CacheStore {
  const namespace = getAiResponseCacheNamespace();
  return namespace ? namespace.getByName(cacheShard(key)) : localStore;
}

/** Collect the first lookup of each independent decision before reading bounded shard chunks. */
export class AiResponseCacheBatch {
  private pending: Set<number>;
  private requests: {
    key: string;
    force: boolean;
    resolve(value: CacheClaim): void;
    reject(error: UnparsedError): void;
  }[] = [];

  constructor(size: number) {
    this.pending = new Set(Array.from({ length: size }, (_, index) => index));
  }

  ready(index: number) {
    this.pending.delete(index);
    if (!this.pending.size) this.flush();
  }

  readOrClaim(index: number, key: string, force: boolean): Promise<CacheClaim> {
    if (!this.pending.has(index))
      return Promise.resolve(cacheStore(key).readOrClaim(key, force));
    const result = new Promise<CacheClaim>((resolve, reject) => {
      this.requests.push({ key, force, resolve, reject });
    });
    this.ready(index);
    return result;
  }

  private flush() {
    const groups = new Map<string, typeof this.requests>();
    for (const request of this.requests) {
      const shard = getAiResponseCacheNamespace()
        ? cacheShard(request.key)
        : "local";
      const group = groups.get(shard) ?? [];
      group.push(request);
      groups.set(shard, group);
    }
    this.requests = [];
    for (const group of groups.values()) {
      for (
        let offset = 0;
        offset < group.length;
        offset += AI_RESPONSE_CACHE_BATCH_SIZE
      ) {
        const chunk = group.slice(
          offset,
          offset + AI_RESPONSE_CACHE_BATCH_SIZE,
        );
        void Promise.resolve()
          .then(async () => {
            const results = await cacheStore(chunk[0]!.key).readOrClaimMany(
              chunk.map(({ key, force }) => ({ key, force })),
            );
            if (results.length !== chunk.length)
              throw new Error(
                `AI response cache returned ${results.length} results for ${chunk.length} keys`,
              );
            for (const [index, request] of chunk.entries())
              request.resolve(results[index]!);
          })
          .catch((error: unknown) => {
            for (const request of chunk) request.reject(error);
          });
      }
    }
  }
}

export async function withAiResponseCache<T>(args: {
  enabled: boolean;
  batch?: { batch: AiResponseCacheBatch; index: number };
  keyInput: AiResponseCacheKeyInput;
  force?: boolean;
  validate(value: JsonValue): T;
  compute(status: ApplicationCacheStatus): Promise<T>;
  onHit?(durationMs: number): Promise<void>;
  /** A batch may dispatch its owned misses while another request owns this key. */
  onWait?(): void;
}): Promise<T> {
  if (!args.enabled) {
    args.batch?.batch.ready(args.batch.index);
    return args.compute("none");
  }
  const key = await aiResponseCacheKey(args.keyInput);
  if (!key) {
    args.batch?.batch.ready(args.batch.index);
    return args.compute("none");
  }
  const store = cacheStore(key);
  const start = performance.now();
  const deadline = Date.now() + 5 * 60_000;
  let force = !!args.force;
  while (Date.now() < deadline) {
    let claim: Awaited<ReturnType<CacheStore["readOrClaim"]>>;
    try {
      claim = await (args.batch
        ? args.batch.batch.readOrClaim(args.batch.index, key, force)
        : store.readOrClaim(key, force));
    } catch (error) {
      log.error("lookup failed", { error });
      return args.compute("none");
    }
    if (claim.kind === "hit") {
      let result: T;
      try {
        result = args.validate(jsonSchema.parse(JSON.parse(claim.value)));
      } catch (error) {
        // SILENT: An invalid cached value is discarded so the model can answer.
        log.warn("entry rejected", { error });
        try {
          await store.invalidate(key, claim.value);
        } catch (error) {
          log.error("invalidation failed", { error });
          return args.compute("none");
        }
        continue;
      }
      await args.onHit?.(Math.max(0, Math.round(performance.now() - start)));
      return result;
    }
    if (claim.kind === "busy") {
      args.onWait?.();
      force = false;
      await sleep(250);
      continue;
    }
    const token = claim.token;
    const heartbeat = setInterval(() => {
      void Promise.resolve(store.renew(key, token)).catch((error) => {
        // SILENT: A failed renewal leaves the lease reclaimable after expiry.
        log.error("lease renewal failed", { error });
      });
    }, 15_000);
    try {
      const result = args.validate(
        jsonSchema.parse(await args.compute("miss")),
      );
      const value = JSON.stringify(result);
      if (new TextEncoder().encode(value).byteLength <= MAX_VALUE_BYTES) {
        try {
          await store.publish(key, token, value, CACHE_TTL_MS);
        } catch (error) {
          // SILENT: Cache persistence is best effort after a valid model result.
          log.error("publish failed", { error });
        }
      } else {
        await store.release(key, token);
      }
      return result;
    } catch (error) {
      await Promise.resolve(store.release(key, token)).catch((releaseError) => {
        // SILENT: Preserve the original model failure; the lease still expires.
        log.error("claim release failed", { error: releaseError });
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
  return args.compute("none");
}
