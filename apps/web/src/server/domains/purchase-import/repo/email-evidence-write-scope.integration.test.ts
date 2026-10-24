import { sql, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { withConnection } from "~/server/db";
import {
  getDb,
  withTransactionDatabase,
  runAfterCommit,
  runBeforeCommitDatabase,
} from "~/server/db/helpers";
import { assessmentCorrectionLock, ledgerParty } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  assertEmailEvidenceScope,
  withEmailEvidenceWrite,
} from "./email-evidence-write-scope";

describe("Email evidence outer scope", () => {
  const ctx = withTestDb();
  const marker = () =>
    insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic scope original",
      kind: "member",
      userId: ctx.actor.userId,
    });

  it("rejects a late root entry without writing a gate", async () => {
    const before = await getDb(ctx.db).select().from(assessmentCorrectionLock);
    await withTransactionDatabase(ctx.db, async (db) => {
      await expect(
        withEmailEvidenceWrite(db, async () => undefined),
      ).rejects.toThrow("root Database");
    });
    expect(await getDb(ctx.db).select().from(assessmentCorrectionLock)).toEqual(
      before,
    );
  });

  it("binds authority to the live transaction and its savepoints", async () => {
    const party = await marker();
    await withConnection(ctx.db, async (connection) => {
      const old = await withEmailEvidenceWrite(
        connection,
        async (db, scope) => {
          assertEmailEvidenceScope(db, scope);
          const forged: unknown = Reflect.construct(scope.constructor, []);
          expect(() => assertEmailEvidenceScope(db, forged)).toThrow(
            "not active",
          );
          for (const copied of [
            { ...scope },
            Object.create(Object.getPrototypeOf(scope)),
          ]) {
            expect(() => assertEmailEvidenceScope(db, copied)).toThrow(
              "not active",
            );
          }
          await runBeforeCommitDatabase(
            db,
            async (committing) => {
              assertEmailEvidenceScope(committing, scope);
              await expect(
                withEmailEvidenceWrite(connection, async () => undefined),
              ).rejects.toThrow("Reuse");
            },
            "validation",
          );
          expect(() => assertEmailEvidenceScope(ctx.db, scope)).toThrow(
            "not active",
          );
          await expect(
            withEmailEvidenceWrite(connection, async () => undefined),
          ).rejects.toThrow("Reuse");
          const child = await withTransactionDatabase(db, async (nested) => {
            assertEmailEvidenceScope(nested, scope);
            return nested;
          });
          expect(() => assertEmailEvidenceScope(child, scope)).toThrow(
            "not active",
          );
          await expect(
            withTransactionDatabase(db, async (nested) => {
              assertEmailEvidenceScope(nested, scope);
              await getDb(nested)
                .update(ledgerParty)
                .set({ name: "Synthetic abandoned savepoint" })
                .where(eq(ledgerParty.id, party.id));
              throw new Error("Synthetic savepoint rollback");
            }),
          ).rejects.toThrow("Synthetic savepoint rollback");
          expect(
            (
              await getDb(db)
                .select()
                .from(ledgerParty)
                .where(eq(ledgerParty.id, party.id))
            )[0]?.name,
          ).toBe("Synthetic scope original");
          await withTransactionDatabase(ctx.db, async (unrelated) => {
            expect(() => assertEmailEvidenceScope(unrelated, scope)).toThrow(
              "not active",
            );
          });
          return { db, scope };
        },
      );
      expect(() => assertEmailEvidenceScope(old.db, old.scope)).toThrow(
        "not active",
      );
      await withEmailEvidenceWrite(connection, async (db) => {
        expect(() => assertEmailEvidenceScope(db, old.scope)).toThrow(
          "not active",
        );
      });
    });
  });

  it("serializes roots before their domain work and refreshes a waiting snapshot", async () => {
    const party = await marker();
    await withEmailEvidenceWrite(ctx.db, async () => undefined);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = withEmailEvidenceWrite(ctx.db, async (db, scope) => {
      assertEmailEvidenceScope(db, scope);
      await getDb(db)
        .update(ledgerParty)
        .set({ name: "Synthetic scope committed" })
        .where(eq(ledgerParty.id, party.id));
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const started = Promise.withResolvers<number>();
    let secondCalls = 0;
    const second = withConnection(ctx.db, async (connection) => {
      const result = z
        .object({ rows: z.array(z.object({ pid: z.number() })).min(1) })
        .parse(
          await getDb(connection).execute(sql`SELECT pg_backend_pid() AS pid`),
        );
      const row = result.rows[0];
      if (!row) throw new Error("Synthetic connection PID missing");
      started.resolve(row.pid);
      return withEmailEvidenceWrite(connection, async (db, scope) => {
        secondCalls += 1;
        assertEmailEvidenceScope(db, scope);
        expect(
          (
            await getDb(db)
              .select()
              .from(ledgerParty)
              .where(eq(ledgerParty.id, party.id))
          )[0]?.name,
        ).toBe("Synthetic scope committed");
      });
    });
    const pid = await started.promise;
    try {
      await expect
        .poll(
          async () => {
            const result = z
              .object({
                rows: z.array(z.object({ waiting: z.boolean().nullable() })),
              })
              .parse(
                await getDb(ctx.db).execute(
                  sql`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`,
                ),
              );
            return result.rows[0]?.waiting;
          },
          { timeout: 2000 },
        )
        .toBe(true);
      expect(secondCalls).toBe(0);
    } finally {
      release.resolve();
    }
    const results = await Promise.allSettled([first, second]);
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
    expect(secondCalls).toBe(1);
  });

  it("does not replay a committed write when an after-commit effect fails", async () => {
    const party = await marker();
    let calls = 0;
    await expect(
      withEmailEvidenceWrite(ctx.db, async (db, scope) => {
        calls += 1;
        await getDb(db)
          .update(ledgerParty)
          .set({ name: "Synthetic committed despite notification" })
          .where(eq(ledgerParty.id, party.id));
        await runAfterCommit(db, async () => {
          expect(() => assertEmailEvidenceScope(db, scope)).toThrow(
            "not active",
          );
          throw new Error("Synthetic notification failure");
        });
      }),
    ).rejects.toThrow("committed");
    expect(calls).toBe(1);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(ledgerParty)
          .where(eq(ledgerParty.id, party.id))
      )[0]?.name,
    ).toBe("Synthetic committed despite notification");
  });
});
