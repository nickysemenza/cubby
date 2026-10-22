import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";

import { withInvocationTrace } from "~/server/observability/tracing";

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

type CacheRow = {
  value: string | null;
  claim_token: string | null;
  lease_expires_at: number | null;
};

/**
 * One of 64 shards; SQLite coordinates claims across Worker isolates.
 * Completed answers never expire. `expires_at` is retained but ignored: rows
 * written under the retired 30-day expiry stay readable.
 */
export class AiResponseCacheDurableObject
  extends DurableObject<Env>
  implements AiResponseCacheRpc
{
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER, claim_token TEXT, lease_expires_at INTEGER)",
    );
    ctx.storage.sql.exec("DROP INDEX IF EXISTS responses_expires_at_idx");
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS response_chunks (key TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (key, seq))",
    );
  }

  readOrClaim(key: string, force: boolean): CacheClaim {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<CacheRow>(
        "SELECT value, claim_token, lease_expires_at FROM responses WHERE key = ?",
        key,
      )
      .toArray()[0];
    if (row?.claim_token && (row.lease_expires_at ?? 0) > now) {
      return { kind: "busy" };
    }
    if (!force && row?.value)
      return {
        kind: "hit",
        value: storedValue(this.ctx.storage.sql, key, row.value),
      };
    const token = crypto.randomUUID();
    // A forced claim keeps the current answer until its replacement publishes.
    this.ctx.storage.sql.exec(
      "INSERT INTO responses (key, value, claim_token, lease_expires_at) VALUES (?, NULL, ?, ?) ON CONFLICT(key) DO UPDATE SET claim_token = excluded.claim_token, lease_expires_at = excluded.lease_expires_at",
      key,
      token,
      now + LEASE_MS,
    );
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
      this.ctx.storage.sql.exec(
        "UPDATE responses SET lease_expires_at = ? WHERE key = ? AND claim_token = ?",
        Date.now() + LEASE_MS,
        key,
        token,
      ).rowsWritten > 0
    );
  }

  publish(key: string, token: string, value: string): boolean {
    const sql = this.ctx.storage.sql;
    if (
      !sql
        .exec(
          "SELECT 1 FROM responses WHERE key = ? AND claim_token = ?",
          key,
          token,
        )
        .toArray().length
    )
      return false;
    sql.exec("DELETE FROM response_chunks WHERE key = ?", key);
    const chunks = chunked(value);
    for (const [seq, chunk] of chunks.entries())
      sql.exec(
        "INSERT INTO response_chunks (key, seq, value) VALUES (?, ?, ?)",
        key,
        seq,
        chunk,
      );
    sql.exec(
      "UPDATE responses SET value = ?, expires_at = NULL, claim_token = NULL, lease_expires_at = NULL WHERE key = ?",
      chunks.length ? `${CHUNKED}${chunks.length}` : value,
      key,
    );
    return true;
  }

  /** A failed claim leaves no row; a failed regeneration keeps its prior answer. */
  release(key: string, token: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM responses WHERE key = ? AND claim_token = ? AND value IS NULL",
      key,
      token,
    );
    this.ctx.storage.sql.exec(
      "UPDATE responses SET claim_token = NULL, lease_expires_at = NULL WHERE key = ? AND claim_token = ?",
      key,
      token,
    );
  }

  /**
   * Drains alarms the retired expiry scheduled. Completed answers stay;
   * abandoned first claims are removed, and every other expired lease is
   * reclaimed by its next lookup.
   */
  async alarm(): Promise<void> {
    return withInvocationTrace(
      "ai.response-cache.alarm",
      async () => {
        this.ctx.storage.sql.exec(
          "DELETE FROM responses WHERE value IS NULL AND lease_expires_at <= ?",
          Date.now(),
        );
      },
      { "cubby.workload": "alarm" },
    );
  }
}

function storedValue(sql: SqlStorage, key: string, value: string) {
  if (!value.startsWith(CHUNKED)) return value;
  return sql
    .exec<{ value: string }>(
      "SELECT value FROM response_chunks WHERE key = ? ORDER BY seq",
      key,
    )
    .toArray()
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
