import {
  type AiAvoidedUsage,
  aiAvoidedUsageSchema,
} from "@cubby/shared/ai/pricing";
import { retryWithBackoff, sleep } from "@cubby/shared/retry";
import { sha256Hex } from "@cubby/shared/sha256";
import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";
import type { AiChatRequest } from "~/server/ai/run-feature";
import { getAiResponseCacheNamespace } from "~/server/cf-env";
import { inJobExecution } from "~/server/generic/jobs/context";
import { JobDeferredError } from "~/server/generic/jobs/errors";

import {
  AI_RESPONSE_CACHE_BATCH_SIZE,
  type CacheClaim,
} from "./response-cache-rpc";

const log = createLogger("ai-response-cache");

const LEASE_MS = 90_000;
const WAIT_DEADLINE_MS = 5 * 60_000;
// Long enough for a held lease to publish before the page runs again.
const DEFER_MS = 15_000;
const PUBLISH_ATTEMPTS = 3;
// Below the 32 MiB Durable Object RPC message bound; the shard stores larger
// values than one SQLite row across chunk rows.
const MAX_VALUE_BYTES = 16_000_000;
const MAX_LOCAL_ENTRIES = 512;
// Holds one answer at MAX_VALUE_BYTES: UTF-8 never has fewer bytes than UTF-16 units.
const MAX_UNWRITTEN_CHARS = 16_000_000;

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
  /** The JSON Schema the provider is asked to answer with. */
  outputSchema?: object;
  embedding?: { text: string; dimensions: number };
  request?: AiChatRequest;
}

interface CacheStore {
  readOrClaim(key: string, force: boolean): Promise<CacheClaim> | CacheClaim;
  readOrClaimMany(
    requests: readonly { key: string; force: boolean }[],
  ): Promise<CacheClaim[]> | CacheClaim[];
  renew(key: string, token: string): Promise<boolean> | boolean;
  publish(
    key: string,
    token: string,
    value: string,
  ): Promise<boolean> | boolean;
  release(key: string, token: string): Promise<void> | void;
}

type LocalRow = {
  value: string | null;
  token: string | null;
  leaseUntil: number;
};

class LocalCacheStore implements CacheStore {
  private rows = new Map<string, LocalRow>();

  readOrClaim(key: string, force: boolean) {
    const row = this.rows.get(key);
    const now = Date.now();
    if (row?.token && row.leaseUntil > now) return { kind: "busy" as const };
    if (!force && row?.value) return { kind: "hit" as const, value: row.value };
    const token = crypto.randomUUID();
    this.rows.set(key, {
      value: row?.value ?? null,
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

  publish(key: string, token: string, value: string) {
    const row = this.rows.get(key);
    if (row?.token !== token) return false;
    this.rows.set(key, { value, token: null, leaseUntil: 0 });
    return true;
  }

  release(key: string, token: string) {
    const row = this.rows.get(key);
    if (row?.token !== token) return;
    if (row.value) row.token = null;
    else this.rows.delete(key);
  }
}

const localStore = new LocalCacheStore();

const ignoreUsage = () => undefined;

// Entries published before usage retention hold the bare answer. Entries do
// not expire, so both shapes stay readable; the marker key cannot occur in an
// answer, and a bare entry keeps its avoided usage unknown.
const ENTRY_MARKER = "$cubbyResponseCacheEntry";
const ENTRY_VERSION = 2;
const versionedEntrySchema = z.object({
  [ENTRY_MARKER]: z.literal(ENTRY_VERSION),
  value: jsonSchema,
  usage: aiAvoidedUsageSchema.nullable(),
});

function readEntry(stored: string): {
  value: JsonValue;
  usage: AiAvoidedUsage | null;
} {
  const value = jsonSchema.parse(JSON.parse(stored));
  const entry = versionedEntrySchema.safeParse(value);
  return entry.success
    ? { value: entry.data.value, usage: entry.data.usage }
    : { value, usage: null };
}

/** Every call that produced the answer; a hit avoids all of them. */
function sumUsage(usage: readonly AiAvoidedUsage[]): AiAvoidedUsage {
  const total = (key: keyof AiAvoidedUsage) =>
    usage.every((entry) => entry[key] == null)
      ? null
      : usage.reduce((sum, entry) => sum + (entry[key] ?? 0), 0);
  return {
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    cacheReadTokens: total("cacheReadTokens"),
    cacheWriteTokens: total("cacheWriteTokens"),
  };
}

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
): Promise<string> {
  const payload = jsonSchema.parse(JSON.parse(JSON.stringify(input)));
  return sha256Hex(JSON.stringify(canonical({ version: 1, payload })));
}

const cacheShard = (key: string) =>
  `shard-${parseInt(key.slice(0, 2), 16) % 64}`;

function cacheStore(key: string): CacheStore {
  const namespace = getAiResponseCacheNamespace();
  return namespace ? namespace.getByName(cacheShard(key)) : localStore;
}

/** Collect the first lookup of each independent decision before reading bounded shard chunks. */
export class AiResponseCacheBatch {
  private owned = new Map<string, { token: string; done: Promise<void> }>();

  /** Only duplicates owned by this finite wave may wait inside a Job. */
  waitForOwned(key: string) {
    return this.owned.get(key)?.done;
  }

  own(key: string, token: string) {
    const completion = Promise.withResolvers<void>();
    this.owned.set(key, { token, done: completion.promise });
    return () => {
      if (this.owned.get(key)?.token !== token) return;
      this.owned.delete(key);
      completion.resolve();
    };
  }

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
  /** `recordUsage` keeps the tokens this answer consumed with its entry. */
  compute(
    status: ApplicationCacheStatus,
    recordUsage: (usage: AiAvoidedUsage) => void,
  ): Promise<T>;
  /** `avoided` is null for entries published before usage was retained. */
  onHit?(durationMs: number, avoided: AiAvoidedUsage | null): Promise<void>;
  /** A batch may dispatch its owned misses while another request owns this key. */
  onWait?(): void;
}): Promise<T> {
  if (!args.enabled) {
    args.batch?.batch.ready(args.batch.index);
    return args.compute("none", ignoreUsage);
  }
  const key = await aiResponseCacheKey(args.keyInput);
  const store = cacheStore(key);
  const start = performance.now();
  const recovered = await publishUnwritten(store, key, args.validate);
  if (recovered) {
    args.batch?.batch.ready(args.batch.index);
    return recovered.result;
  }
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  let force = !!args.force;
  while (Date.now() < deadline) {
    let claim: CacheClaim;
    try {
      claim = await (args.batch
        ? args.batch.batch.readOrClaim(args.batch.index, key, force)
        : store.readOrClaim(key, force));
    } catch (error) {
      log.error("lookup failed", { error });
      throw deferred(
        "The AI response cache lookup failed; no uncached model call was placed.",
        error,
      );
    }
    if (claim.kind === "hit") {
      let result: T;
      let avoided: AiAvoidedUsage | null;
      try {
        const entry = readEntry(claim.value);
        avoided = entry.usage;
        result = args.validate(entry.value);
      } catch (error) {
        // SILENT: A forced claim replaces an entry this code rejects.
        log.warn("entry rejected", { error });
        force = true;
        continue;
      }
      dropUnwritten(key);
      await args.onHit?.(
        Math.max(0, Math.round(performance.now() - start)),
        avoided,
      );
      return result;
    }
    if (claim.kind === "busy") {
      args.onWait?.();
      // Let the owning question dispatch before awaiting a duplicate in this
      // wave. A sibling's completion is finite and needs no lease polling.
      const owned = args.batch?.batch.waitForOwned(key);
      if (owned) {
        await owned;
        force = false;
        continue;
      }
      // A job page republishes its cursor instead of polling another invocation.
      if (inJobExecution())
        throw deferred(
          "Another request is computing this AI answer; no duplicate model call was placed.",
        );
      force = false;
      await sleep(250);
      continue;
    }
    const token = claim.token;
    const finish = args.batch?.batch.own(key, token);
    try {
      const heartbeat = setInterval(() => {
        void Promise.resolve(store.renew(key, token)).catch((error) => {
          // SILENT: A failed renewal leaves the lease reclaimable after expiry.
          log.error("lease renewal failed", { error });
        });
      }, 15_000);
      let result: T;
      let value: string;
      try {
        const kept = keptAnswer(key, args.validate);
        if (kept) {
          ({ result, value } = kept);
        } else {
          const usage: AiAvoidedUsage[] = [];
          result = args.validate(
            jsonSchema.parse(
              await args.compute("miss", (recorded) => usage.push(recorded)),
            ),
          );
          value = JSON.stringify({
            [ENTRY_MARKER]: ENTRY_VERSION,
            value: result,
            usage: usage.length ? sumUsage(usage) : null,
          });
        }
        const bytes = new TextEncoder().encode(value).byteLength;
        if (bytes > MAX_VALUE_BYTES)
          throw new Error(
            `AI answer ${key} is ${bytes} bytes, above the ${MAX_VALUE_BYTES}-byte response cache bound; it was not stored.`,
          );
      } catch (error) {
        clearInterval(heartbeat);
        await releaseClaim(store, key, token);
        throw error;
      }
      try {
        if (!(await publish(store, key, token, value)))
          throw new Error(
            "The cache claim expired before the answer was written.",
          );
      } catch (error) {
        // The claim is left to expire so another isolate cannot pay for the
        // same answer while this one can still write it.
        log.error("publish failed", { error });
        keepUnwritten(key, token, value);
        throw deferred(
          "The AI answer was not written to the response cache; a retry in this Worker writes it without another model call.",
          error,
        );
      } finally {
        clearInterval(heartbeat);
      }
      dropUnwritten(key);
      return result;
    } finally {
      finish?.();
    }
  }
  throw deferred(
    "Another request was still computing this AI answer after 5 minutes; no duplicate model call was placed.",
  );
}

/**
 * A job republishes its page after `until`; an interactive caller surfaces
 * the error. Either way the raw cause stays on its chain.
 */
function deferred(message: string, cause?: UnparsedError): JobDeferredError {
  const error = new JobDeferredError(
    message,
    new Date(Date.now() + DEFER_MS),
    "provider_capacity",
  );
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Answers whose write failed, by key. A later call in this isolate writes
 * one instead of paying again; another isolate or a restart cannot see it.
 */
const unwritten = new Map<string, { token: string; value: string }>();
let unwrittenChars = 0;

function dropUnwritten(key: string) {
  const kept = unwritten.get(key);
  if (!kept) return;
  unwritten.delete(key);
  unwrittenChars -= kept.value.length;
}

function keepUnwritten(key: string, token: string, value: string) {
  dropUnwritten(key);
  unwritten.set(key, { token, value });
  unwrittenChars += value.length;
  // Oldest first, within the entry bound and about 32 MB of UTF-16.
  while (
    unwritten.size > MAX_LOCAL_ENTRIES ||
    unwrittenChars > MAX_UNWRITTEN_CHARS
  )
    dropUnwritten(unwritten.keys().next().value!);
}

function keptAnswer<T>(
  key: string,
  validate: (value: JsonValue) => T,
): { result: T; value: string } | null {
  const kept = unwritten.get(key);
  if (!kept) return null;
  try {
    return { result: validate(readEntry(kept.value).value), value: kept.value };
  } catch (error) {
    // SILENT: This caller's validation rejects the kept answer; it recomputes.
    log.warn("kept answer rejected", { error });
    dropUnwritten(key);
    return null;
  }
}

/** Writes a kept answer under the claim that produced it, while that lease lasts. */
async function publishUnwritten<T>(
  store: CacheStore,
  key: string,
  validate: (value: JsonValue) => T,
): Promise<{ result: T } | null> {
  const token = unwritten.get(key)?.token;
  const kept = token ? keptAnswer(key, validate) : null;
  if (!token || !kept) return null;
  try {
    if (!(await store.publish(key, token, kept.value))) return null;
  } catch (error) {
    // SILENT: The normal claim path retries the write once it reclaims the key.
    log.error("kept answer publish failed", { error });
    return null;
  }
  dropUnwritten(key);
  return { result: kept.result };
}

function publish(store: CacheStore, key: string, token: string, value: string) {
  return retryWithBackoff(async () => store.publish(key, token, value), {
    delayFor: (outcome, attempt) =>
      outcome.ok || attempt >= PUBLISH_ATTEMPTS - 1
        ? null
        : 250 * (attempt + 1),
  });
}

async function releaseClaim(store: CacheStore, key: string, token: string) {
  await Promise.resolve()
    .then(() => store.release(key, token))
    .catch((error: unknown) => {
      // SILENT: Preserve the call's outcome; the lease still expires.
      log.error("claim release failed", { error });
    });
}
