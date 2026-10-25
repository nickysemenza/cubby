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
import {
  readEmail,
  saveMailboxMetadata,
} from "~/server/domains/purchase-import/repo/gmail/persistence";
import * as refreshFamilies from "~/server/generic/derived-refresh/repo/families";
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";
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
// The second client commits real Email source invalidation after intake's
// snapshot, before its search upsert. Unchanged metadata must be distinguished
// from a member search, which renews acquisition expiry even for the same mail.
describe("finance.record Email persistence contention", () => {
  const ctx = withTestDb();
  it.each([
    { conflicts: 1, memberSearch: false },
    { conflicts: 3, memberSearch: false },
    { conflicts: 1, memberSearch: true },
  ])(
    "preserves admission and exact replay after $conflicts Email saves (member search: $memberSearch)",
    async ({ conflicts, memberSearch }) => {
      const member = await createRepoEntity(ctx, "ledgerParty", {
        name: "Synthetic intake member",
        kind: "member",
      });
      await getDb(ctx.db)
        .update(ledgerParty)
        .set({ userId: ctx.actor.userId })
        .where(eq(ledgerParty.id, member.entityId));
      const metadata = {
        ledgerPartyId: member.entityId,
        checksum: "synthetic-mail-checksum",
        executionPolicy: "classification_only",
        mail: {
          sourceKey: "synthetic-mail-source",
          mailboxId: "synthetic-mailbox",
          messageId: "synthetic-message",
          threadId: "synthetic-thread",
          historyId: "1",
          internalDate: "2026-05-04T00:00:00.000Z",
          labelIds: [],
          headers: {
            from: "receipts@example.test",
            subject: "Synthetic receipt",
          },
          snippet: null,
          bodyText: null,
          bodyHtml: null,
        },
      } satisfies Parameters<typeof saveMailboxMetadata>[1];
      await saveMailboxMetadata(ctx.db, metadata);
      const emailIdentity = {
        ledgerPartyId: member.entityId,
        mailboxId: metadata.mail.mailboxId,
        messageId: metadata.mail.messageId,
      };
      const originalEmail = await readEmail(ctx.db, emailIdentity);
      expect(originalEmail).not.toBeNull();
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
      let savingEmail = false;
      const writerCommits: {
        startedAt: number;
        committedAt: number;
        durationMs: number;
        generation: number;
        xmin: string;
      }[] = [];
      const searchTuple = async () =>
        z
          .object({ generation: z.number(), xmin: z.string() })
          .parse(
            (
              await getDb(ctx.db).execute(
                sql`SELECT generation, xmin::text AS xmin FROM "Job" WHERE key = 'refresh:search'`,
              )
            ).rows[0],
          );
      const originalTuple = await searchTuple();
      const racing = vi
        .spyOn(refreshFamilies, "invalidateRefreshFamily")
        .mockImplementation(async (db, family) => {
          if (!savingEmail && family === "search" && ++attempts <= conflicts) {
            // A pooled handle leases a separate client from the open intake
            // transaction. The real save commits its own capture before return.
            savingEmail = true;
            const startedAt = Date.now();
            const started = performance.now();
            try {
              await withDatabaseOperationMetrics(
                () =>
                  saveMailboxMetadata(ctx.db, { ...metadata, memberSearch }),
                "fedcba9876543210-SJC",
              );
              writerCommits.push({
                startedAt,
                committedAt: Date.now(),
                durationMs: performance.now() - started,
                ...(await searchTuple()),
              });
            } finally {
              savingEmail = false;
            }
          }
          return invalidate(db, family);
        });
      try {
        let result = await record();
        const diagnostics = warnings.mock.calls.flatMap(([entry]) => {
          const parsed = abortedAttempt.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        });
        console.info({
          scope: "synthetic-email-contention",
          conflicts,
          memberSearch,
          writerDurationsMs: writerCommits.map((writer) => writer.durationMs),
          attemptDurationsMs: diagnostics.map((attempt) => attempt.durationMs),
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
        expect(writerCommits).toHaveLength(conflicts);
        let previousXmin = originalTuple.xmin;
        for (const [index, writer] of writerCommits.entries()) {
          expect(writer.generation).toBe(search.generation + index + 1);
          expect(writer.xmin).not.toBe(previousXmin);
          previousXmin = writer.xmin;
          const attempt = diagnostics[index]!;
          expect(writer.startedAt).toBeGreaterThanOrEqual(attempt.startedAt);
          expect(writer.committedAt).toBeLessThanOrEqual(
            attempt.startedAt + attempt.durationMs + 1,
          );
        }
        const savedEmail = await readEmail(ctx.db, emailIdentity);
        expect(savedEmail).not.toBeNull();
        if (!savedEmail || !originalEmail) return;
        const renewedAcquisition = {
          updatedAt: expect.any(Date),
          searchOrigin: "member_search",
          searchExpiresAt: expect.any(Date),
        };
        // Routine unchanged metadata leaves every Email column untouched;
        // member search deliberately renews its acquisition metadata.
        expect(savedEmail).toEqual(
          memberSearch
            ? { ...originalEmail, ...renewedAcquisition }
            : originalEmail,
        );
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
          generation: search.generation + conflicts + admitted,
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
          generation: search.generation + conflicts + 1,
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
      }
    },
  );
});
