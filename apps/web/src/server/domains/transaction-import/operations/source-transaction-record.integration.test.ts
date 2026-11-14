import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { sql } from "drizzle-orm";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import * as changes from "~/server/generic/changes/repo/change";
import { systemPrincipal } from "~/server/http/authenticate";

import { sourceTransactionRecordHandlers } from "./source-transaction-record.server";

const syntheticIntake = () =>
  recordSourceTransactionRecordsInput.parse({
    import: {
      source: "monarch",
      label: "synthetic-contention.csv",
      fingerprint: "synthetic-contention-intake",
      dateKind: "posted",
      rowCountDeclared: 1,
      notes: null,
    },
    rows: [
      {
        rowPosition: 1,
        accountDescriptor: "Synthetic card 4242",
        statementDate: "2026-05-04",
        providerAmount: -42.5,
        merchant: "Synthetic Orchard",
        rawDescription: "SYNTHETIC ORCHARD",
        sourceCategory: "Groceries",
      },
    ],
  });

describe("finance.record evidence admission", () => {
  const ctx = withTestDb();
  it("rolls back captured intent with rejected operation admission without an external writer", async () => {
    const before = await getDb(ctx.db).execute(
      sql`SELECT name, key, xmin::text AS xmin FROM "Pass" ORDER BY name, key`,
      "objects",
    );
    const invalidate = changes.recordChange;
    const capture = vi
      .spyOn(changes, "recordChange")
      .mockImplementation(async (db, changeEvent) => {
        await invalidate(db, changeEvent);
        if (
          changeEvent.kind === "source" &&
          changeEvent.categories.length === 0
        )
          throw new Error("Synthetic capture rejection");
      });
    try {
      const result = await sourceTransactionRecordHandlers.operations.record({
        data: syntheticIntake(),
        request: {
          principal: systemPrincipal(
            buildKernelContext(ctx.db, ctx.actor.userId),
          ),
          headers: new Headers({ "cf-ray": "0123456789abcdef-SJC" }),
          signal: new AbortController().signal,
        },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { message: "Synthetic capture rejection" },
      });
      expect(
        await getDb(ctx.db).execute(
          sql`SELECT name, key, xmin::text AS xmin FROM "Pass" ORDER BY name, key`,
          "objects",
        ),
      ).toEqual(before);
      // The rolled-back capture left no wake behind.
      expect(
        (
          await getDb(ctx.db).execute(
            sql`SELECT
        (SELECT count(*)::int FROM "TransactionImport") AS imports,
        (SELECT count(*)::int FROM "TransactionImportRecord") AS memberships,
        (SELECT count(*)::int FROM "SourceTransactionRecord") AS records,
        (SELECT count(*)::int FROM "Run" WHERE purpose = 'sweep') AS sweeps,
        (SELECT count(*)::int FROM "Expense") AS expenses`,
            "objects",
          )
        )[0],
      ).toEqual({
        imports: 0,
        memberships: 0,
        records: 0,
        sweeps: 0,
        expenses: 0,
      });
    } finally {
      capture.mockRestore();
    }
  });

  it("atomically discovers a bank event and preserves evidence and dirty intent on exact replay", async () => {
    const invoke = () =>
      sourceTransactionRecordHandlers.operations.record({
        data: syntheticIntake(),
        request: {
          principal: systemPrincipal(
            buildKernelContext(ctx.db, ctx.actor.userId),
          ),
          headers: new Headers(),
          signal: new AbortController().signal,
        },
      });
    expect(await invoke()).toMatchObject({ ok: true, data: { inserted: 1 } });
    const read = () =>
      getDb(ctx.db).execute(
        sql`SELECT
      (SELECT count(*)::int FROM "TransactionImport") AS imports,
      (SELECT count(*)::int FROM "TransactionImportRecord") AS memberships,
      (SELECT count(*)::int FROM "SourceTransactionRecord") AS observations,
      (SELECT count(*)::int FROM "SourceOccurrence") AS occurrences,
      (SELECT count(*)::int FROM "ScopeDirty" WHERE "scopeKind"='bankEvent') AS bank_scopes,
      (SELECT count(*)::int FROM "Expense") AS expenses`,
        "objects",
      );
    const before = await read();
    expect(before).toEqual([
      {
        imports: 1,
        memberships: 1,
        observations: 1,
        occurrences: 1,
        bank_scopes: 1,
        expenses: 0,
      },
    ]);
    const revisions = await getDb(ctx.db).execute(
      sql`SELECT key, rev FROM "KeyRev" ORDER BY key`,
      "objects",
    );
    expect(await invoke()).toMatchObject({
      ok: true,
      data: { inserted: 0, unchanged: 1 },
    });
    expect(await read()).toEqual(before);
    expect(
      await getDb(ctx.db).execute(
        sql`SELECT key, rev FROM "KeyRev" ORDER BY key`,
        "objects",
      ),
    ).toEqual(revisions);
  });
});
