import { sleep } from "@cubby/shared/retry";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { setCfEnv } from "~/server/cf-env";

import { initializeResponseCache } from "./repo/response-cache-initialization";
import baseline from "./repo/response-cache-migrations/0000_legacy_baseline.sql?raw";
import journal from "./repo/response-cache-migrations/meta/_journal.json";
import { withAiResponseCache } from "./response-cache";

describe("AI response cache Durable Object", () => {
  // Existing workflows initialize new stores. This guards adoption of paid-for
  // legacy answers and in-flight claims, which an empty store cannot exercise.
  it("adopts legacy rows and chunks before serving RPCs and accepts later migrations on restart", async () => {
    const stub = env.AI_RESPONSE_CACHE.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DROP TABLE __drizzle_migrations");
        state.storage.sql.exec("DROP TABLE response_chunks");
        state.storage.sql.exec("DROP TABLE responses");
        state.storage.sql.exec(
          "CREATE TABLE responses (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER, claim_token TEXT, lease_expires_at INTEGER)",
        );
        state.storage.sql.exec(
          "CREATE INDEX responses_expires_at_idx ON responses(expires_at)",
        );
        state.storage.sql.exec(
          "CREATE TABLE response_chunks (key TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (key, seq))",
        );
        state.storage.sql.exec(
          "INSERT INTO responses VALUES ('inline', 'retained', 1, NULL, NULL), ('large', 'chunked:2', 1, NULL, NULL), ('refresh', 'prior', NULL, 'legacy-claim', ?), ('expired', NULL, NULL, 'expired-claim', 1)",
          Date.now() + 90_000,
        );
        state.storage.sql.exec(
          "INSERT INTO response_chunks VALUES ('large', 1, 'second'), ('large', 0, 'first')",
        );
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(stub);
    expect(
      await Promise.all([
        stub.readOrClaim("inline", false),
        stub.readOrClaim("large", false),
        stub.readOrClaim("refresh", false),
      ]),
    ).toEqual([
      { kind: "hit", value: "retained" },
      { kind: "hit", value: "firstsecond" },
      { kind: "busy" },
    ]);
    expect(await stub.renew("refresh", "wrong-claim")).toBe(false);
    expect(await stub.renew("refresh", "legacy-claim")).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT * FROM responses WHERE key = 'expired'")
          .toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name = 'responses_expires_at_idx'",
          )
          .toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec("PRAGMA table_info('responses')").toArray()[0]
          ?.notnull,
      ).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
      const entry = journal.entries[0];
      if (!entry) throw new Error("Baseline migration missing");
      // Test-only upgrade changes the catalog; production needs no extra field.
      await migrate(drizzle(state.storage), {
        journal: {
          entries: [
            ...journal.entries,
            {
              ...entry,
              idx: 1,
              when: entry.when + 1,
              tag: "synthetic_upgrade",
            },
          ],
        },
        migrations: {
          m0000: baseline,
          m0001: "ALTER TABLE responses ADD COLUMN synthetic_revision TEXT",
        },
      });
    });
    await evictDurableObject(stub);
    expect(await stub.publish("refresh", "legacy-claim", "replacement")).toBe(
      true,
    );
    expect(await stub.readOrClaim("refresh", false)).toEqual({
      kind: "hit",
      value: "replacement",
    });
    await evictDurableObject(stub);
    expect(await stub.readOrClaim("large", false)).toEqual({
      kind: "hit",
      value: "firstsecond",
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT created_at FROM __drizzle_migrations")
          .toArray(),
      ).toHaveLength(2);
      expect(
        state.storage.sql.exec("PRAGMA table_info('responses')").toArray(),
      ).toContainEqual(expect.objectContaining({ name: "synthetic_revision" }));
    });
  });

  it("rejects an incompatible legacy table before journal adoption and gates RPCs on that failure", async () => {
    const stub = env.AI_RESPONSE_CACHE.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DROP TABLE __drizzle_migrations");
      state.storage.sql.exec(
        "ALTER TABLE responses RENAME COLUMN claim_token TO incompatible_claim",
      );
      state.storage.sql.exec(
        "INSERT INTO responses (key, value) VALUES ('retained', 'legacy-answer')",
      );
      await expect(initializeResponseCache(state.storage)).rejects.toThrow(
        "Incompatible AI response cache legacy table: responses",
      );
      expect(
        state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'",
          )
          .toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql
          .exec("SELECT value FROM responses WHERE key = 'retained'")
          .toArray(),
      ).toEqual([{ value: "legacy-answer" }]);
    });
    await evictDurableObject(stub);
    const startupError = await stub.readOrClaim("retained", false).then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    expect(startupError).toContain(
      "Incompatible AI response cache legacy table: responses",
    );
  });

  it("shares one model result through the Worker cache client", async () => {
    setCfEnv(env);
    try {
      const keyInput = {
        feature: "test",
        model: "test-model",
        promptVersion: "1",
        input: {
          state: crypto.randomUUID(),
          questions: {
            selection: {
              type: "choice" as const,
              instructions: "Choose one.",
              criteria: { c0: "one" },
            },
          },
        },
      };
      let calls = 0;
      const args = {
        enabled: true,
        keyInput,
        validate: z.object({ choice: z.string() }).parse,
        compute: async () => {
          calls += 1;
          await sleep(20);
          return { choice: "one" };
        },
      };
      const answers = await Promise.all([
        withAiResponseCache(args),
        withAiResponseCache(args),
      ]);
      expect(answers).toEqual([{ choice: "one" }, { choice: "one" }]);
      expect(calls).toBe(1);
    } finally {
      setCfEnv(undefined);
    }
  });

  // Batch reads retain the single-key hit/busy/miss and lease behavior.
  it("reads and claims multiple keys with a bounded additive RPC", async () => {
    const stub = env.AI_RESPONSE_CACHE.getByName(crypto.randomUUID());
    const hit = await stub.readOrClaim("hit", false);
    if (hit.kind !== "claimed") throw new Error("claim missing");
    await stub.publish("hit", hit.token, "cached");
    await stub.readOrClaim("busy", false);
    const requests = ["hit", "busy", "missing"].map((key) => ({
      key,
      force: false,
    }));
    const results = await stub.readOrClaimMany(requests);
    expect(results.slice(0, 2)).toEqual(
      await Promise.all(
        ["hit", "busy"].map((key) => stub.readOrClaim(key, false)),
      ),
    );
    expect(results[2]?.kind).toBe("claimed");
    const miss = results[2];
    if (miss?.kind !== "claimed") throw new Error("batch miss claim missing");
    expect(await stub.publish("missing", miss.token, "new")).toBe(true);
    expect(await stub.readOrClaim("missing", false)).toEqual({
      kind: "hit",
      value: "new",
    });
    expect(await stub.readOrClaimMany([])).toEqual([]);
    await runInDurableObject(stub, (instance) => {
      expect(() =>
        instance.readOrClaimMany(
          Array.from({ length: 129 }, (_, index) => ({
            key: `overflow-${index}`,
            force: false,
          })),
        ),
      ).toThrow("at most 128");
    });
    expect((await stub.readOrClaim("overflow-0", false)).kind).toBe("claimed");
  });

  it("coordinates claims across stubs and retains completed values after eviction", async () => {
    const name = crypto.randomUUID();
    const first = env.AI_RESPONSE_CACHE.getByName(name);
    const second = env.AI_RESPONSE_CACHE.getByName(name);
    const claim = await first.readOrClaim("key", false);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("claim missing");
    expect(await second.readOrClaim("key", false)).toEqual({ kind: "busy" });
    expect(
      await first.publish(
        "key",
        claim.token,
        JSON.stringify({ choice: "one" }),
      ),
    ).toBe(true);
    expect(await second.readOrClaim("key", false)).toEqual({
      kind: "hit",
      value: JSON.stringify({ choice: "one" }),
    });
    await evictDurableObject(first);
    expect(await second.readOrClaim("key", false)).toMatchObject({
      kind: "hit",
    });
    const refresh = await second.readOrClaim("key", true);
    expect(refresh.kind).toBe("claimed");
    if (refresh.kind !== "claimed") throw new Error("refresh claim missing");
    expect(await first.publish("key", claim.token, "stale")).toBe(false);
    // An abandoned regeneration keeps the answer it would have replaced.
    await second.release("key", refresh.token);
    expect(await first.readOrClaim("key", false)).toEqual({
      kind: "hit",
      value: JSON.stringify({ choice: "one" }),
    });
  });

  // Regression: completed answers expired after 30 days and were paid for again.
  it("retains a completed value written with the retired expiry", async () => {
    const stub = env.AI_RESPONSE_CACHE.getByName(crypto.randomUUID());
    const claim = await stub.readOrClaim("key", false);
    if (claim.kind !== "claimed") throw new Error("claim missing");
    await stub.publish("key", claim.token, "retained");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE responses SET expires_at = 1 WHERE key = ?",
        "key",
      );
    });
    await evictDurableObject(stub);
    expect(await stub.readOrClaim("key", false)).toEqual({
      kind: "hit",
      value: "retained",
    });
  });

  // Regression: values above one SQLite row were released uncached.
  it("stores a value larger than one row and replaces it inline", async () => {
    const stub = env.AI_RESPONSE_CACHE.getByName(crypto.randomUUID());
    // A surrogate pair straddles the first chunk boundary.
    const large = `${"a".repeat(499_999)}😀${"b".repeat(700_000)}`;
    const claim = await stub.readOrClaim("key", false);
    if (claim.kind !== "claimed") throw new Error("claim missing");
    expect(await stub.publish("key", claim.token, large)).toBe(true);
    await evictDurableObject(stub);
    expect(await stub.readOrClaim("key", false)).toEqual({
      kind: "hit",
      value: large,
    });
    const refresh = await stub.readOrClaim("key", true);
    if (refresh.kind !== "claimed") throw new Error("refresh claim missing");
    await stub.publish("key", refresh.token, "small");
    expect(await stub.readOrClaim("key", false)).toEqual({
      kind: "hit",
      value: "small",
    });
  });

  it("reclaims an abandoned lease without accepting a late publisher", async () => {
    const stub = env.AI_RESPONSE_CACHE.getByName(crypto.randomUUID());
    const abandoned = await stub.readOrClaim("key", false);
    if (abandoned.kind !== "claimed") throw new Error("claim missing");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE responses SET lease_expires_at = 0 WHERE key = ?",
        "key",
      );
    });
    const replacement = await stub.readOrClaim("key", false);
    expect(replacement.kind).toBe("claimed");
    expect(await stub.publish("key", abandoned.token, "late")).toBe(false);
  });
});
