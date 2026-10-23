import type { DurableObjectState } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";
import { and, eq, isNull, lte } from "drizzle-orm";
import {
  drizzle,
  type DrizzleSqliteDODatabase,
} from "drizzle-orm/durable-sqlite";

import { initializeResponseCache } from "./repo/response-cache-initialization";
import { responseChunks, responses } from "./repo/response-cache-sql-schema";
import {
  AI_RESPONSE_CACHE_BATCH_SIZE,
  type AiResponseCacheRpc,
  type CacheClaim,
} from "./response-cache-rpc";

const LEASE_MS = 90_000;
// UTF-16 units; at most three UTF-8 bytes each keeps a chunk row under
// SQLite's 2 MB row bound.
const CHUNK_CHARS = 500_000;
// A stored value is client JSON, which never starts with this prefix.
const CHUNKED = "chunked:";

/**
 * One of 64 shards; SQLite coordinates claims across Worker isolates.
 * Completed answers never expire. `expires_at` is retained but ignored: rows
 * written under the retired 30-day expiry stay readable.
 */
export class AiResponseCacheDurableObject
  extends DurableObject<Env>
  implements AiResponseCacheRpc
{
  private readonly db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      await initializeResponseCache(ctx.storage);
      this.db
        .delete(responses)
        .where(
          and(
            isNull(responses.value),
            lte(responses.leaseExpiresAt, Date.now()),
          ),
        )
        .run();
      await ctx.storage.deleteAlarm();
    });
  }

  readOrClaim(key: string, force: boolean): CacheClaim {
    const now = Date.now();
    const row = this.db
      .select()
      .from(responses)
      .where(eq(responses.key, key))
      .get();
    if (row?.claimToken && (row.leaseExpiresAt ?? 0) > now) {
      return { kind: "busy" };
    }
    if (!force && row?.value)
      return {
        kind: "hit",
        value: storedValue(this.db, key, row.value),
      };
    const token = crypto.randomUUID();
    // A forced claim keeps the current answer until its replacement publishes.
    this.db
      .insert(responses)
      .values({
        key,
        value: null,
        claimToken: token,
        leaseExpiresAt: now + LEASE_MS,
      })
      .onConflictDoUpdate({
        target: responses.key,
        set: { claimToken: token, leaseExpiresAt: now + LEASE_MS },
      })
      .run();
    return { kind: "claimed", token };
  }

  /** Additive RPC: existing entries, claims and single-key callers share the same store. */
  readOrClaimMany(
    requests: readonly { key: string; force: boolean }[],
  ): CacheClaim[] {
    if (requests.length > AI_RESPONSE_CACHE_BATCH_SIZE)
      throw new Error(
        `AI response cache batch supports at most ${AI_RESPONSE_CACHE_BATCH_SIZE} keys, got ${requests.length}`,
      );
    return requests.map(({ key, force }) => this.readOrClaim(key, force));
  }

  renew(key: string, token: string): boolean {
    return (
      this.db
        .update(responses)
        .set({ leaseExpiresAt: Date.now() + LEASE_MS })
        .where(and(eq(responses.key, key), eq(responses.claimToken, token)))
        .returning({ key: responses.key })
        .get() !== undefined
    );
  }

  publish(key: string, token: string, value: string): boolean {
    // No await: claim validation, chunks and the pointer update share the DO's
    // synchronous critical section and implicit storage transaction.
    if (
      !this.db
        .select({ key: responses.key })
        .from(responses)
        .where(and(eq(responses.key, key), eq(responses.claimToken, token)))
        .get()
    )
      return false;
    this.db.delete(responseChunks).where(eq(responseChunks.key, key)).run();
    const chunks = chunked(value);
    for (const [seq, chunk] of chunks.entries())
      this.db.insert(responseChunks).values({ key, seq, value: chunk }).run();
    this.db
      .update(responses)
      .set({
        value: chunks.length ? `${CHUNKED}${chunks.length}` : value,
        expiresAt: null,
        claimToken: null,
        leaseExpiresAt: null,
      })
      .where(eq(responses.key, key))
      .run();
    return true;
  }

  /** A failed claim leaves no row; a failed regeneration keeps its prior answer. */
  release(key: string, token: string): void {
    this.db
      .delete(responses)
      .where(
        and(
          eq(responses.key, key),
          eq(responses.claimToken, token),
          isNull(responses.value),
        ),
      )
      .run();
    this.db
      .update(responses)
      .set({ claimToken: null, leaseExpiresAt: null })
      .where(and(eq(responses.key, key), eq(responses.claimToken, token)))
      .run();
  }
}

function storedValue(db: DrizzleSqliteDODatabase, key: string, value: string) {
  if (!value.startsWith(CHUNKED)) return value;
  return db
    .select({ value: responseChunks.value })
    .from(responseChunks)
    .where(eq(responseChunks.key, key))
    .orderBy(responseChunks.seq)
    .all()
    .map((chunk) => chunk.value)
    .join("");
}

/** No chunks for a value that fits one row; never splits a surrogate pair. */
function chunked(value: string): string[] {
  if (value.length <= CHUNK_CHARS) return [];
  const chunks: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + CHUNK_CHARS, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}
