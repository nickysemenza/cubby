import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { withConnection } from "~/server/db";
import {
  getDb,
  withTransactionDatabase,
  runAfterCommit,
  runBeforeCommitDatabase,
} from "~/server/db/helpers";
import { ledgerParty } from "~/server/db/schema";

import {
  assertEmailEvidenceScope,
  withEmailEvidenceWrite,
} from "./email-evidence-write-scope";

describe("Email evidence outer scope", () => {
  const ctx = withTestDb();
  const marker = async () => {
    const created = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic scope original",
      kind: "member",
    });
    return { id: created.entityId };
  };

  it("rejects a late root entry", async () => {
    await withTransactionDatabase(ctx.db, async (db) => {
      await expect(
        withEmailEvidenceWrite(db, async () => undefined),
      ).rejects.toThrow("root Database");
    });
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

  it("does not replay a committed write when an after-commit effect fails", async () => {
    const party = await marker();
    let calls = 0;
    const notificationError = Object.assign(
      new Error("Synthetic notification failure"),
      { code: "40001" },
    );
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
          throw notificationError;
        });
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error && error.cause === notificationError,
    );
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
