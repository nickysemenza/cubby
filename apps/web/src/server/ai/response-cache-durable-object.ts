import type { DurableObjectState } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";

import { withInvocationTrace } from "~/server/observability/tracing";

import {
  AI_RESPONSE_CACHE_BATCH_SIZE,
  type AiResponseCacheRpc,
  type CacheClaim,
} from "./response-cache-rpc";

const LEASE_MS = 90_000;
const DAY_MS = 86_400_000;

type CacheRow = {
  value: string | null;
  expires_at: number | null;
  claim_token: string | null;
  lease_expires_at: number | null;
};

/** One of 64 shards; SQLite coordinates claims across Worker isolates. */
export class AiResponseCacheDurableObject
  extends DurableObject<Env>
  implements AiResponseCacheRpc
{
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER, claim_token TEXT, lease_expires_at INTEGER)",
    );
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS responses_expires_at_idx ON responses (expires_at)",
    );
  }

  readOrClaim(key: string, force: boolean): CacheClaim {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<CacheRow>(
        "SELECT value, expires_at, claim_token, lease_expires_at FROM responses WHERE key = ?",
        key,
      )
      .toArray()[0];
    if (row?.claim_token && (row.lease_expires_at ?? 0) > now) {
      return { kind: "busy" };
    }
    if (!force && row?.value && (row.expires_at ?? 0) > now) {
      return { kind: "hit", value: row.value };
    }
    const token = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO responses (key, value, expires_at, claim_token, lease_expires_at) VALUES (?, NULL, NULL, ?, ?) ON CONFLICT(key) DO UPDATE SET value = NULL, expires_at = NULL, claim_token = excluded.claim_token, lease_expires_at = excluded.lease_expires_at",
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

  async publish(
    key: string,
    token: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> {
    const written =
      this.ctx.storage.sql.exec(
        "UPDATE responses SET value = ?, expires_at = ?, claim_token = NULL, lease_expires_at = NULL WHERE key = ? AND claim_token = ?",
        value,
        Date.now() + ttlMs,
        key,
        token,
      ).rowsWritten > 0;
    if (written && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    }
    return written;
  }

  release(key: string, token: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM responses WHERE key = ? AND claim_token = ?",
      key,
      token,
    );
  }

  invalidate(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM responses WHERE key = ? AND value = ? AND claim_token IS NULL",
      key,
      value,
    );
  }

  async alarm(): Promise<void> {
    return withInvocationTrace(
      "ai.response-cache.alarm",
      async () => {
        const now = Date.now();
        this.ctx.storage.sql.exec(
          "DELETE FROM responses WHERE key IN (SELECT key FROM responses WHERE (expires_at IS NOT NULL AND expires_at <= ?) OR (claim_token IS NOT NULL AND lease_expires_at <= ?) LIMIT 500)",
          now,
          now,
        );
        const remaining = this.ctx.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM responses")
          .one().count;
        if (remaining > 0) await this.ctx.storage.setAlarm(now + DAY_MS);
      },
      { "cubby.workload": "alarm" },
    );
  }
}
