import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { withDatabaseOperationMetrics } from "~/server/db/db-observability";
import { getDb } from "~/server/db/helpers";
import { ledgerParty } from "~/server/db/schema";
import * as refreshFamilies from "~/server/generic/derived-refresh/repo/families";
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { systemPrincipal } from "~/server/http/authenticate";

import { sourceTransactionRecordHandlers } from "./source-transaction-record.server";

const abortedAttempt = z.object({
  scope: z.literal("db-transaction"),
  boundaryId: z.string(),
  rootBoundaryId: z.string(),
  rootAttempt: z.number(),
  requestId: z.string(),
  callerOwned: z.boolean(),
  caller: z.string(),
  isolationLevel: z.string(),
  attempt: z.number(),
  limit: z.number(),
  phase: z.string(),
  beforeCommitKey: z.string(),
  startedAt: z.number(),
  durationMs: z.number(),
  retry: z.boolean(),
});
const publicationLog = z.object({
  scope: z.literal("jobs"),
  message: z.literal("[jobs] publish"),
  jobId: z.string(),
  jobKey: z.string(),
  generation: z.number(),
  publicationStartedAt: z.number(),
  publicationDurationMs: z.number(),
  published: z.boolean(),
});

// The real operation includes intake savepoints and Sweep admission. A second
// client publishes a real Job page after its snapshot, before the search upsert.
// This owns admission rollback/replay and request-correlated contention evidence.
describe("finance.record publication contention", () => {
  const ctx = withTestDb();
  it.each([1, 3])(
    "preserves admission and exact replay after %i competing search pages",
    async (conflicts) => {
      const member = await createRepoEntity(ctx, "ledgerParty", {
        name: "Synthetic intake member",
        kind: "member",
      });
      await getDb(ctx.db)
        .update(ledgerParty)
        .set({ userId: ctx.actor.userId })
        .where(eq(ledgerParty.id, member.entityId));
      const search = await enqueueJob(ctx.db, {
        key: "refresh:search",
        kind: "refresh.family",
        input: { family: "search" },
      });
      const input = recordSourceTransactionRecordsInput.parse({
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
      const record = () =>
        sourceTransactionRecordHandlers.operations.record({
          data: input,
          request: {
            principal: systemPrincipal(
              buildKernelContext(ctx.db, ctx.actor.userId),
            ),
            headers: new Headers({ "cf-ray": "0123456789abcdef-SJC" }),
            signal: new AbortController().signal,
          },
        });
      const read = async () =>
        (
          await getDb(ctx.db).execute(sql`SELECT
      (SELECT count(*)::int FROM "TransactionImport") AS imports,
      (SELECT count(*)::int FROM "TransactionImportRecord") AS memberships,
      (SELECT count(*)::int FROM "SourceTransactionRecord") AS records,
      (SELECT count(*)::int FROM "Run" WHERE purpose = 'sweep') AS sweeps,
      (SELECT count(*)::int FROM "Job" WHERE kind = 'run.execute') AS "sweepJobs",
      (SELECT count(*)::int FROM "Expense") AS expenses,
      (SELECT generation FROM "Job" WHERE key = 'refresh:search') AS generation`)
        ).rows[0];
      let attempts = 0;
      const invalidate = refreshFamilies.invalidateRefreshFamily;
      const warnings = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const information = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);
      const racing = vi
        .spyOn(refreshFamilies, "invalidateRefreshFamily")
        .mockImplementation(async (db, family) => {
          if (family === "search" && ++attempts <= conflicts) {
            // The other client has its own invocation correlation, not intake's.
            const outcome = await withDatabaseOperationMetrics(
              () =>
                advanceJob(ctx.db, search.id, {
                  "refresh.family": {
                    prepare: async () => ({
                      page: {
                        done: false,
                        cursor: { syntheticPage: attempts },
                      },
                    }),
                  },
                }),
              "fedcba9876543210-SJC",
            );
            if (outcome !== "succeeded")
              throw new Error(`Synthetic search publication ${outcome}`);
          }
          return invalidate(db, family);
        });
      try {
        let result = await record();
        const diagnostics = warnings.mock.calls.flatMap(([entry]) => {
          const parsed = abortedAttempt.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        });
        expect(diagnostics).toHaveLength(conflicts);
        for (const [index, diagnostic] of diagnostics.entries()) {
          expect(diagnostic).toMatchObject({
            boundaryId: diagnostics[0]!.boundaryId,
            rootBoundaryId: diagnostics[0]!.boundaryId,
            rootAttempt: index + 1,
            requestId: "0123456789abcdef-SJC",
            callerOwned: false,
            caller: "start.mutation.sourceTransactionRecord.record",
            isolationLevel: "serializable",
            attempt: index + 1,
            limit: 3,
            phase: "before-commit:capture",
            beforeCommitKey: "refresh:search",
            retry: index < 2,
          });
        }
        const publications = information.mock.calls.flatMap(([entry]) => {
          const parsed = publicationLog.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        });
        expect(publications).toHaveLength(conflicts);
        for (const [index, publication] of publications.entries()) {
          expect(publication).toMatchObject({
            jobId: search.id,
            jobKey: "refresh:search",
            generation: search.generation,
            published: true,
          });
          const attempt = diagnostics[index]!;
          expect(publication.publicationStartedAt).toBeGreaterThanOrEqual(
            attempt.startedAt,
          );
          expect(publication.publicationStartedAt).toBeLessThanOrEqual(
            attempt.startedAt + attempt.durationMs + 1,
          );
        }
        expect(attempts).toBe(Math.min(conflicts + 1, 3));
        const failed = {
          ok: false,
          error: {
            message: expect.stringContaining(
              "could not serialize access due to concurrent update",
            ),
            requestId: "0123456789abcdef-SJC",
          },
        };
        expect(result).toMatchObject(
          conflicts === 3 ? failed : { ok: true, data: { inserted: 1 } },
        );
        const admitted = conflicts === 3 ? 0 : 1;
        expect(await read()).toEqual({
          imports: admitted,
          memberships: admitted,
          records: admitted,
          sweeps: admitted,
          sweepJobs: admitted,
          expenses: 0,
          generation: search.generation + admitted,
        });
        racing.mockRestore();
        if (!result.ok) result = await record();
        expect(result).toMatchObject({ ok: true, data: { inserted: 1 } });
        expect(await read()).toEqual({
          imports: 1,
          memberships: 1,
          records: 1,
          sweeps: 1,
          sweepJobs: 1,
          expenses: 0,
          generation: search.generation + 1,
        });
        const stored = await read();
        expect(await record()).toMatchObject({
          ok: true,
          data: { inserted: 0 },
        });
        expect(await read()).toEqual(stored);
      } finally {
        racing.mockRestore();
        warnings.mockRestore();
        information.mockRestore();
      }
    },
  );
});
