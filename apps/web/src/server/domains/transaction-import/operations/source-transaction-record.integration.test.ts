import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { eq, inArray, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { withDatabaseOperationMetrics } from "~/server/db/db-observability";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { image, imageProcessingAttempt, ledgerParty } from "~/server/db/schema";
import {
  claimImageProcessingJob,
  completeImageProcessingJob,
} from "~/server/domains/image-processing/repo/image-processing";
import { assignImageProcessingExecutor } from "~/server/domains/image-processing/repo/image-processing-history";
import { scheduleImageProcessingJobs } from "~/server/domains/image-processing/service/image-processing.service";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import {
  readEmail,
  saveMailboxMetadata,
} from "~/server/domains/purchase-import/repo/gmail/persistence";
import * as changes from "~/server/generic/changes/repo/change";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { claimJob, renewJob } from "~/server/generic/jobs/repo/queue";
import { systemPrincipal } from "~/server/http/authenticate";
import { derivedMarkTickets } from "~/server/testing/background-queue";

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
// Competing source and Job lifecycle writes use a second client after intake's
// snapshot. Generated marks retain derived work without replacing the drain Job.
describe("finance.record source and Job lifecycle contention", () => {
  const ctx = withTestDb();
  async function prepareCloudCompletion() {
    const source = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "synthetic-capture.jpg",
      contentType: "image/jpeg",
      size: 128,
    });
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "a".repeat(64) })
      .where(eq(image.id, source.id));
    const scheduled = await scheduleImageProcessingJobs(ctx.db, {
      id: source.shortcode,
      kinds: ["describe_image"],
      publish: false,
    });
    const jobId = scheduled.jobIds[0];
    if (!jobId) throw new Error("Missing synthetic image job");
    const lease = await claimImageProcessingJob(ctx.db, {
      jobId,
      kinds: ["describe_image"],
      leaseMs: 60_000,
    });
    if (!lease) throw new Error("Missing synthetic image claim");
    expect(
      await assignImageProcessingExecutor(ctx.db, {
        jobId,
        attemptId: lease.attemptId,
        executor: {
          kind: "cloud",
          deviceId: null,
          name: "test",
          platform: "cloud",
          appVersion: null,
          osVersion: null,
        },
      }),
    ).toBe(true);
    return { jobId, attemptId: lease.attemptId };
  }
  it("rolls back captured intent with rejected operation admission without an external writer", async () => {
    const before = await getDb(ctx.db).execute(
      sql`SELECT key, generation, xmin::text AS xmin FROM "Job" ORDER BY key`,
    );
    const marksBefore = await getDb(ctx.db).execute(
      sql`SELECT target, ref, ticket FROM "WorkItem" ORDER BY target, ref`,
    );
    const invalidationsBefore = await getDb(ctx.db).execute(
      sql`SELECT id, key FROM "JobInvalidationCapture" ORDER BY id`,
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
        (
          await getDb(ctx.db).execute(
            sql`SELECT key, generation, xmin::text AS xmin FROM "Job" ORDER BY key`,
          )
        ).rows,
      ).toEqual(before.rows);
      expect(
        (
          await getDb(ctx.db).execute(
            sql`SELECT target, ref, ticket FROM "WorkItem" ORDER BY target, ref`,
          )
        ).rows,
      ).toEqual(marksBefore.rows);
      // The rolled-back capture left no wake behind.
      expect(
        (
          await getDb(ctx.db).execute(
            sql`SELECT id, key FROM "JobInvalidationCapture" ORDER BY id`,
          )
        ).rows,
      ).toEqual(invalidationsBefore.rows);
      expect(
        (
          await getDb(ctx.db).execute(sql`SELECT
        (SELECT count(*)::int FROM "TransactionImport") AS imports,
        (SELECT count(*)::int FROM "TransactionImportRecord") AS memberships,
        (SELECT count(*)::int FROM "SourceTransactionRecord") AS records,
        (SELECT count(*)::int FROM "Run" WHERE purpose = 'sweep') AS sweeps,
        (SELECT count(*)::int FROM "Expense") AS expenses`)
        ).rows[0],
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
  it.each([
    { conflicts: 1, change: "none" },
    { conflicts: 1, change: "subject" },
    { conflicts: 3, change: "subject" },
    { conflicts: 1, change: "member_search" },
    { conflicts: 1, change: "claim" },
    { conflicts: 1, change: "renew" },
    { conflicts: 3, change: "renew" },
    { conflicts: 1, change: "cloud_completion" },
    { conflicts: 3, change: "cloud_completion" },
  ])(
    "preserves admission and exact replay after $conflicts competing writes (change: $change)",
    async ({ conflicts, change }) => {
      const lifecycle = change === "claim" || change === "renew";
      // Genuine source captures and execution work use independent write rows.
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
        key: "derived:drain",
        kind: "derived.drain",
        input: {},
      });
      const cloudCompletions: Awaited<
        ReturnType<typeof prepareCloudCompletion>
      >[] = [];
      if (change === "cloud_completion") {
        for (let index = 0; index < conflicts; index++) {
          cloudCompletions.push(await prepareCloudCompletion());
        }
      }
      const input = syntheticIntake();
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
      (SELECT count(*)::int FROM "Expense") AS expenses`)
        ).rows[0];
      let attempts = 0;
      const invalidate = changes.recordChange;
      const warnings = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      let savingEmail = false;
      const writerCommits: {
        durationMs: number;
        generation: number;
        xmin: string;
      }[] = [];
      const searchTuple = async () =>
        z
          .object({
            generation: z.number(),
            xmin: z.string(),
          })
          .parse(
            (
              await getDb(ctx.db).execute(
                sql`SELECT generation, xmin::text AS xmin FROM "Job" WHERE key = 'derived:drain'`,
              )
            ).rows[0],
          );
      const claim =
        change === "renew" ? await claimJob(ctx.db, search.id) : null;
      if (change === "renew" && !claim)
        throw new Error("Expected synthetic search claim");
      const clients: { financePid: number; writerPid: number }[] = [];
      const backendPid = async (db: Parameters<typeof repositoryQueries>[0]) =>
        z
          .object({ pid: z.number() })
          .parse(
            (
              await repositoryQueries(db).execute(
                sql`SELECT pg_backend_pid() AS pid`,
              )
            ).rows[0],
          ).pid;
      const originalTuple = await searchTuple();
      const racing = vi
        .spyOn(changes, "recordChange")
        .mockImplementation(async (db, changeEvent) => {
          if (
            !savingEmail &&
            changeEvent.kind === "source" &&
            changeEvent.categories.length === 0 &&
            ++attempts === 1
          ) {
            // A pooled handle leases a second client after the intake snapshot.
            // The real source or lifecycle owner commits before capture resumes.
            savingEmail = true;
            const started = performance.now();
            try {
              for (
                let writeIndex = 0;
                writeIndex < (change === "cloud_completion" ? 1 : conflicts);
                writeIndex++
              ) {
                await withDatabaseOperationMetrics(async () => {
                  // Lifecycle owners commit through a second pooled client and
                  // replace the execution tuple, never the invalidation row.
                  if (lifecycle) {
                    const financePid = await backendPid(db);
                    await withTransactionDatabase(ctx.db, async (writerDb) => {
                      const writerPid = await backendPid(writerDb);
                      clients.push({ financePid, writerPid });
                      const written =
                        change === "claim"
                          ? (await claimJob(writerDb, search.id)) !== null
                          : claim !== null && (await renewJob(writerDb, claim));
                      if (!written)
                        throw new Error(`Synthetic search ${change} refused`);
                    });
                    return;
                  }
                  if (change === "cloud_completion") {
                    for (const completion of cloudCompletions) {
                      // Finish a real, independently claimed image after intake's
                      // SERIALIZABLE snapshot; its required projection capture commits first.
                      const completed = await completeImageProcessingJob(
                        ctx.db,
                        {
                          result: {
                            ...completion,
                            completedAt: new Date().toISOString(),
                            outcome: {
                              kind: "describe_image",
                              status: "completed",
                              description: {
                                description: "A synthetic orchard",
                                claims: [],
                                cutoutEligibility: "eligible",
                              },
                              runtime: {
                                platform: "cloud",
                                model: "synthetic-vision",
                              },
                            },
                          },
                          cloudAnalysis: {
                            provider: "test",
                            model: "synthetic-vision",
                            promptRevision: 1,
                            resultSchemaRevision: 1,
                            inputFingerprint: "synthetic-input",
                          },
                        },
                      );
                      if (!completed.adopted)
                        throw new Error("Synthetic cloud completion refused");
                    }
                    return;
                  }
                  await saveMailboxMetadata(ctx.db, {
                    ...metadata,
                    mail: {
                      ...metadata.mail,
                      headers: {
                        ...metadata.mail.headers,
                        subject:
                          change === "subject"
                            ? `Synthetic revised receipt ${writeIndex + 1}`
                            : metadata.mail.headers.subject,
                      },
                    },
                    memberSearch: change === "member_search",
                  });
                }, "fedcba9876543210-SJC");
                writerCommits.push({
                  durationMs: performance.now() - started,
                  ...(await searchTuple()),
                });
              }
            } finally {
              savingEmail = false;
            }
          }
          return invalidate(db, changeEvent);
        });
      try {
        const result = await record();
        const diagnostics = warnings.mock.calls.flatMap(([entry]) => {
          const parsed = abortedAttempt.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        });
        expect(
          clients.every(
            ({ financePid, writerPid }) => financePid !== writerPid,
          ),
        ).toBe(true);
        console.info({
          scope: "synthetic-source-job-contention",
          conflicts,
          change,
          clients,
          writerDurationsMs: writerCommits.map((writer) => writer.durationMs),
          attemptDurationsMs: diagnostics.map((attempt) => attempt.durationMs),
        });
        expect(diagnostics).toHaveLength(0);
        const completedCloudAttempts = await getDb(ctx.db)
          .select({
            state: imageProcessingAttempt.state,
            result: imageProcessingAttempt.result,
          })
          .from(imageProcessingAttempt)
          .where(
            inArray(
              imageProcessingAttempt.id,
              cloudCompletions.map((c) => c.attemptId),
            ),
          );
        expect(completedCloudAttempts).toHaveLength(cloudCompletions.length);
        for (const completed of completedCloudAttempts)
          expect(completed).toMatchObject({
            state: "ready",
            result: {
              kind: "describe_image",
              status: "completed",
              description: { description: "A synthetic orchard" },
            },
          });
        expect(
          await derivedMarkTickets(
            ctx.db,
            "sourceTransactionRecord.searchDocument",
          ),
        ).not.toEqual([]);
        expect(writerCommits).toHaveLength(
          change === "cloud_completion" ? 1 : conflicts,
        );
        let previousXmin = originalTuple.xmin;
        for (const writer of writerCommits) {
          // Source marks append drain intent; lifecycle writes replace its execution row.
          expect(writer.xmin === previousXmin).toBe(!lifecycle);
          expect(
            change !== "renew" ||
              writer.generation === originalTuple.generation,
          ).toBe(true);
          previousXmin = writer.xmin;
        }
        const savedEmail = await readEmail(ctx.db, emailIdentity);
        expect(savedEmail).not.toBeNull();
        if (!savedEmail || !originalEmail) return;
        const updatedAt = expect.any(Date);
        const renewedAcquisition = {
          updatedAt,
          searchOrigin: "member_search",
          searchExpiresAt: expect.any(Date),
        };
        // Routine unchanged metadata leaves every Email column untouched;
        // member search deliberately renews its acquisition metadata.
        expect(savedEmail).toEqual(
          change === "member_search"
            ? { ...originalEmail, ...renewedAcquisition }
            : change === "subject"
              ? {
                  ...originalEmail,
                  subject: `Synthetic revised receipt ${conflicts}`,
                  updatedAt,
                }
              : originalEmail,
        );
        expect(attempts).toBe(1);
        expect(result).toMatchObject({ ok: true, data: { inserted: 1 } });
        const admitted = 1;
        expect(await read()).toEqual({
          imports: admitted,
          memberships: admitted,
          records: admitted,
          sweeps: admitted,
          sweepJobs: admitted,
          expenses: 0,
        });
        racing.mockRestore();
        expect(result).toMatchObject({ ok: true, data: { inserted: 1 } });
        expect(await read()).toEqual({
          imports: 1,
          memberships: 1,
          records: 1,
          sweeps: 1,
          sweepJobs: 1,
          expenses: 0,
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
