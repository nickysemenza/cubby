import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import {
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
} from "@cubby/schemas/mailbox-research";
import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { run, vendor } from "~/server/db/schema";
import {
  issueExecutionAuthorization,
  revokeExecutionAuthorization,
} from "~/server/domains/run/repo/execution-authorization";
import { loadMailDiscoveryRead } from "~/server/domains/run/repo/run-discovery-read";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import type { WorkflowLauncher } from "~/server/workflows/runs/launcher";

import {
  advanceVendorHistory,
  startAuthorizedVendorMail,
} from "./vendor-history";
import { readRecordWorkQueue, readWorkQueue } from "./work-queue-read";

// Missing-domain approval must survive a lost wake, start only after research,
// freeze its queries once, and never reopen an explicitly paused generation.
describe("authorized Vendor history continuation", () => {
  const ctx = withTestDb();
  it("recovers research readiness once without broadening or overriding pause", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic history member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const store = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic history store",
    });
    await getDb(ctx.db)
      .insert(account)
      .values({
        id: crypto.randomUUID(),
        accountId: "synthetic-history-mailbox",
        providerId: "google",
        userId: ctx.actor.userId,
        updatedAt: new Date(),
      });
    const ref = await issueExecutionAuthorization(
      ctx.db,
      ctx.actor,
      executionAuthorizationInput.parse({
        kind: "execution_authorization",
        version: 1,
        owner: { userId: ctx.actor.userId, ledgerPartyId: member.id },
        scope: {
          kind: "vendor_backfill",
          mailboxId: "synthetic-history-mailbox",
          discovery: "vendor_history",
          vendors: [{ vendorId: store.id }],
          senderPolicy: "verified_at_first_start",
          receivedAfter: "2024-01-01",
          receivedBefore: "2026-01-01",
          candidateLimit: 20,
          productLimit: 0,
        },
        meteredBudget: { period: "lifetime", limitMicroUSD: 1_000_000 },
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );
    const launches: string[] = [];
    const launcher: WorkflowLauncher = {
      create: async (_purpose, id) => {
        launches.push(id);
      },
      terminate: async () => {},
      status: async () => ({ state: "missing", error: null }),
    };
    await advanceVendorHistory(
      ctx.db,
      { authorizationRunId: ref.runId },
      launcher,
    );
    const children = () =>
      getDb(ctx.db).select().from(run).where(eq(run.parentRunId, ref.runId));
    const waiting = (await children())[0];
    expect(waiting?.status).toBe("needs_review");
    expect(waiting?.failureCode).toBe("vendor_history_prerequisite");
    expect(launches).toEqual([]);
    if (!waiting) throw new Error("Missing prerequisite Run");
    const snapshotRead = await loadMailDiscoveryRead(
      ctx.db,
      waiting.shortcode,
      { userId: ctx.actor.userId, ledgerPartyId: member.id },
    );
    expect(snapshotRead?.authorization?.scope).toMatchObject({
      vendors: [{ vendorId: store.shortcode }],
    });
    const work = await readRecordWorkQueue(
      ctx.db,
      member.id,
      waiting.shortcode,
      false,
      ctx.actor,
    );
    const overview = await readWorkQueue(
      ctx.db,
      member.id,
      workQueueHouseholdInput.parse({
        view: "automatic",
        vendor: store.shortcode,
      }),
      false,
      ctx.actor,
    );
    expect(overview.items.map((row) => row.id)).toContain(waiting.shortcode);
    expect(work.items[0]?.explanations[0]).toMatchObject({
      readiness: "blocked",
      executor: "automatic",
      prerequisites: [
        {
          code: "vendor_senders",
          record: { entity: "vendor", id: store.shortcode },
        },
      ],
    });
    const research = await readRecordWorkQueue(
      ctx.db,
      member.id,
      store.shortcode,
      false,
      ctx.actor,
    );
    const actions = research.items.flatMap((row) => row.explanations);
    expect(
      actions.find((action) => action.key.endsWith(":vendor_website"))
        ?.unblocks,
    ).toContainEqual(
      expect.objectContaining({
        record: { entity: "run", id: waiting.shortcode },
      }),
    );
    expect(
      actions.find((action) => action.key.endsWith(":vendor_logo"))?.unblocks,
    ).toEqual([]);
    await getDb(ctx.db)
      .update(vendor)
      .set({ website: "https://store.example.test" })
      .where(eq(vendor.id, store.id));
    await advanceVendorHistory(ctx.db, {}, launcher);
    expect(launches).toHaveLength(1);
    const started = (await children())[0];
    const snapshot = mailboxDiscoveryInput.parse(started?.input);
    expect(snapshot.scopedQueries).toEqual([
      {
        key: expect.any(String),
        query: '("example.test") after:2024/01/01 before:2026/01/01',
      },
    ]);
    await getDb(ctx.db)
      .update(vendor)
      .set({ website: "https://different.example.invalid" })
      .where(eq(vendor.id, store.id));
    if (!started) throw new Error("Continuation was not materialized");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused" })
      .where(eq(run.id, started.id));
    await advanceVendorHistory(ctx.db, {}, launcher);
    expect(launches).toHaveLength(1);
    expect((await children())[0]?.input).toEqual(snapshot);
    expect((await children())[0]?.status).toBe("paused");
    expect(await children()).toHaveLength(1);
    // Cancellation is retained history, not another actionable failed task.
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "user_cancelled" })
      .where(eq(run.id, started.id));
    expect(
      (
        await readRecordWorkQueue(
          ctx.db,
          member.id,
          started.shortcode,
          false,
          ctx.actor,
        )
      ).items,
    ).toEqual([]);
    // A bounded pass may finish while its successor waits behind another
    // mailbox Run. Recovery must enumerate that successor, not its old parent.
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed", failureCode: null })
      .where(eq(run.id, started.id));
    const nextGeneration = `mailbox-continuation:${started.id}`;
    const continuation = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_discovery",
      trigger: "backfill",
      status: "needs_review",
      clientKey: nextGeneration,
      parentRunId: ref.runId,
      vendorId: store.id,
      ledgerPartyId: member.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic history member",
      actorEmail: "history@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      failureCode: "vendor_history_mailbox_busy",
      input: {
        ...snapshot,
        vendorHistory: {
          generation: nextGeneration,
          resolvedAt: snapshot.vendorHistory?.resolvedAt ?? null,
        },
      },
      progress: mailboxDiscoveryProgress.parse({
        attempt: 0,
        phase: "listing",
        pagesDone: 0,
        vendorScoped: snapshot.scopedQueries.map((query) => ({
          ...query,
          pageToken: "synthetic-next-page",
          completed: false,
        })),
      }),
    });
    await advanceVendorHistory(ctx.db, {}, launcher);
    expect(launches).toHaveLength(2);
    const recovered = (await children()).find(
      (child) => child.id === continuation.id,
    );
    expect(recovered?.status).toBe("running");
    expect(mailboxDiscoveryInput.parse(recovered?.input).scopedQueries).toEqual(
      snapshot.scopedQueries,
    );
    expect(recovered?.progress).toMatchObject({
      vendorScoped: [{ pageToken: "synthetic-next-page", completed: false }],
    });
    // A revoked retry stays visible with its actual authority diagnostic.
    await getDb(ctx.db)
      .update(run)
      .set({
        status: "needs_review",
        failureCode: "vendor_history_mailbox_busy",
      })
      .where(eq(run.id, continuation.id));
    await revokeExecutionAuthorization(ctx.db, ctx.actor, ref);
    expect(
      await startAuthorizedVendorMail(
        ctx.db,
        { intentRunId: continuation.id, expectedGeneration: nextGeneration },
        launcher,
      ),
    ).toMatchObject({
      status: "refused",
      reason: "approval_revoked_or_expired",
    });
    const refusedWork = await readRecordWorkQueue(
      ctx.db,
      member.id,
      continuation.shortcode,
      false,
      ctx.actor,
    );
    expect(refusedWork.items[0]?.explanations[0]).toMatchObject({
      readiness: "blocked",
      executor: "automatic",
      prerequisites: [
        expect.objectContaining({
          code: "execution_allowance",
          reason: expect.stringContaining("revoked"),
        }),
      ],
    });
    for (const view of ["automatic", "waiting"] as const) {
      const queue = await readWorkQueue(
        ctx.db,
        member.id,
        workQueueHouseholdInput.parse({ view, vendor: store.shortcode }),
        false,
        ctx.actor,
      );
      expect(queue.items.map((row) => row.id)).toContain(
        continuation.shortcode,
      );
    }
  });
});
