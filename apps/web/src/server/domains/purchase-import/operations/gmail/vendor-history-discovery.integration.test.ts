/**
 * Failures: a vendor history Run pages another objective's incomplete query
 * already in the shared mailbox cursor, or moves that cursor; it requests the
 * whole approval instead of its own Vendor; its continuation re-reads Vendor
 * senders, loses its positions, or attaches a generic discovery allowance;
 * a finished vendor pass never wakes waiting generic work.
 */
import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import { mailboxDiscoveryProgress } from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { mailboxCursor, run } from "~/server/db/schema";
import { issueExecutionAuthorization } from "~/server/domains/run/repo/execution-authorization";
import { executionRequestForRun } from "~/server/domains/run/repo/execution-context";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import * as publish from "~/server/workflows/background-tasks/publish";
import type { WorkflowLauncher } from "~/server/workflows/runs/launcher";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import type { GmailProvider } from "../../repo/gmail/types";
import {
  vendorHistoryQueries,
  windowedVendorQuery,
} from "../../repo/gmail/vendor-mail-scope";
import {
  continueMailDiscovery,
  finishMailDiscovery,
  listMailDiscovery,
  saveMailDiscoveryBatch,
  type DiscoveryPorts,
} from "./discovery";

const mailboxId = "synthetic-vendor-mailbox";
const otherObjective = {
  key: "charge:synthetic-other",
  query: '"Other synthetic merchant"',
  pageToken: null,
  completed: false,
};

describe("vendor history discovery", () => {
  const ctx = withTestDb();

  async function world() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic vendor-history member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const [kettle, teapot] = await Promise.all(
      ["Synthetic kettle shop", "Synthetic teapot shop"].map((name) =>
        insertWithShortcode(ctx.db, "vendor", { name }),
      ),
    );
    const window = {
      receivedAfter: "2024-01-01",
      receivedBefore: "2026-10-01",
    };
    const ref = await issueExecutionAuthorization(
      ctx.db,
      ctx.actor,
      executionAuthorizationInput.parse({
        kind: "execution_authorization",
        version: 1,
        owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
        scope: {
          kind: "vendor_backfill",
          mailboxId,
          discovery: "vendor_history",
          vendors: [{ vendorId: kettle!.id }, { vendorId: teapot!.id }],
          senderPolicy: "verified_at_first_start",
          ...window,
          candidateLimit: 10,
          productLimit: 5,
        },
        meteredBudget: { period: "lifetime", limitMicroUSD: 1_000_000 },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    // Another objective left an incomplete query in the shared cursor.
    const coverage = {
      version: 1 as const,
      baselineHistoryId: "100",
      broad: { pageToken: "broad-token", completed: false },
      scoped: [otherObjective],
      history: { historyId: "100", pageToken: null, targetHistoryId: null },
      nextLane: "scan" as const,
    };
    await getDb(ctx.db).insert(mailboxCursor).values({
      ledgerPartyId: party.id,
      mailboxId,
      coverage,
    });
    const queries = vendorHistoryQueries(kettle!.id, [
      "orders@kettle.example.test",
    ]).map((query) => windowedVendorQuery(query, window));
    const created: { runId: string; attempt: number }[] = [];
    const launcher: WorkflowLauncher = {
      create: async (_purpose, _id, params) => {
        created.push(params);
      },
      terminate: async () => undefined,
      status: async () => ({ state: "running", error: null }),
    };
    const vendorRun = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_discovery",
      trigger: "backfill",
      status: "running",
      clientKey: `vendor-history:${ref.runId}:${kettle!.id}`,
      parentRunId: ref.runId,
      vendorId: kettle!.id,
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: party.name,
      actorEmail: "synthetic@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: "member",
      input: {
        emailAuditVersion: 1,
        executionAuthorization: ref,
        executionPolicy: "classification_only",
        mailboxId,
        scopedQueries: queries,
        vendorHistory: {
          generation: `vendor-history:${ref.runId}:${kettle!.id}`,
          resolvedAt: new Date().toISOString(),
        },
      },
      progress: {
        attempt: 0,
        phase: "listing",
        pagesDone: 0,
        saved: 0,
        deleted: 0,
        excluded: 0,
        unrelated: 0,
        events: 0,
        droppedEvents: 0,
      },
    });
    const launched = await launchWorkflowRun(
      ctx.db,
      { runId: vendorRun.id as RunId, purpose: "mail_discovery" },
      launcher,
    );
    return {
      kettle: kettle!,
      queries,
      coverage,
      launcher,
      created,
      params: { runId: vendorRun.id, attempt: launched.attempt },
    };
  }

  const ports = (provider: GmailProvider): DiscoveryPorts => ({
    providerForUser: async () => provider,
    triage: async () => "unrelated",
    relevance: async () => ({ classification: "unrelated" }),
    storage: {
      put: async () => undefined,
      get: async () => new Uint8Array(),
      delete: async () => undefined,
    },
    research: async () => [],
  });

  it("pages only its own frozen queries, keeps the shared cursor, continues from its positions and wakes generic work", async () => {
    const state = await world();
    const listed: { query: string; pageToken?: string }[] = [];
    const provider: GmailProvider = {
      getProfile: async () => ({ historyId: "100" }),
      listMessages: async (request) => {
        listed.push({
          query: request.query ?? "",
          pageToken: request.pageToken,
        });
        return { messages: [], nextPageToken: "kettle-page-two" };
      },
      getMessage: async () => {
        throw new Error("No message is listed");
      },
      listHistory: async () => ({ historyId: "100" }),
      getAttachment: async () => ({}),
    };
    const wake = vi
      .spyOn(publish, "publishInBackground")
      .mockResolvedValue(undefined);

    expect(
      (
        await executionRequestForRun(
          ctx.db,
          runEntityId.parse(state.params.runId),
        )
      )?.requestedScope,
    ).toEqual({
      mailboxId,
      discovery: "vendor_history",
      vendorIds: [state.kettle.id],
    });
    await expect(
      listMailDiscovery(ctx.db, state.params, ports(provider)),
    ).resolves.toEqual({ kind: "listed", more: true });
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, ports(provider));
    expect(listed).toEqual([
      {
        query: `(${state.queries[0]!.query}) -in:spam -in:trash`,
        pageToken: undefined,
      },
    ]);
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage,
    ).toEqual(state.coverage);

    await finishMailDiscovery(ctx.db, state.params);
    expect(wake).toHaveBeenCalledWith(
      expect.anything(),
      [{ kind: "work.advance", requestedAt: expect.any(String) }],
      { source: "mail-discovery:vendor-history" },
    );
    await continueMailDiscovery(ctx.db, state.params, {
      launcher: state.launcher,
    });
    const [next] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.clientKey, `mailbox-continuation:${state.params.runId}`));
    expect(next).toMatchObject({
      status: "running",
      vendorId: state.kettle.id,
      input: {
        executionAuthorization: expect.any(Object),
        scopedQueries: state.queries,
      },
    });
    expect(mailboxDiscoveryProgress.parse(next!.progress).vendorScoped).toEqual(
      [{ ...state.queries[0], pageToken: "kettle-page-two", completed: false }],
    );
    expect(state.created.map((params) => params.runId)).toContain(next!.id);
  });
});
