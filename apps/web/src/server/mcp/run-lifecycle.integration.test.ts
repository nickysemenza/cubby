import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { runShortcode, userId } from "@cubby/schemas/identifiers";
import { mailboxDiscoveryInput } from "@cubby/schemas/mailbox-research";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type JSONType, z } from "zod";

import { setCfEnv } from "~/server/cf-env";
import { account, user } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { runApproval, run as runTable } from "~/server/db/schema";
import { retainedMailFixture } from "~/server/domains/purchase-import/operations/order-import.fixtures";
import { admitMailImport } from "~/server/domains/purchase-import/repo/mail-import-run";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { requireActor } from "~/server/http/request-context";
import { createMcpServer } from "~/server/mcp/server";
import { createTestRequestContext } from "~/server/testing/request-context";
import type { WorkflowRunParams } from "~/server/workflows/runs/contract";

import { callMcpTool } from "../testing/mcp-test-utils";
import { McpOperationContext } from "./operation-context";
import { executePurchaseAgentMutation } from "./purchase-agent-protocol";
import type { ToolExtra } from "./tools/tool-registration";

// Failure modes: lifecycle controls are unavailable; approval leaks through the
// narrower surface; foreign Runs can be stopped; retries mutate settled attempts
// or start duplicate successors instead of reusing their retained lineage.
describe("Run lifecycle through MCP", () => {
  const ctx = withTestDb("mcp");

  beforeEach(() => {
    setCfEnv(
      fromPartial<Env>({
        PURCHASE_AGENT_QUEUE: {
          send: async (_event: PurchaseAgentEvent) => undefined,
        },
      }),
    );
  });
  afterEach(() => setCfEnv(undefined));

  const call = async (runId: string, controlAction: string) => {
    const request = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    return callMcpTool(
      createMcpServer(),
      "run",
      {
        action: "lifecycle",
        runId,
        controlAction,
      },
      request,
      { entityKernel: entityKernelContextSchema.parse(request) },
    );
  };

  const prepare = async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic import member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const mail = await retainedMailFixture(ctx.db, {
      ledgerPartyId: member.id,
      mailboxId: "synthetic-mailbox",
      messageId: "synthetic-order",
      sender: "orders@example.test",
      subject: "Synthetic order",
      receivedAt: new Date("2026-09-01T18:00:00Z"),
      checksum: "a".repeat(64),
      content: { snippet: null, bodyText: "Synthetic order", bodyHtml: null },
    });
    if (!mail) throw new Error("Synthetic retained mail did not persist");
    const [admission] = await admitMailImport(ctx.db, {
      ledgerPartyId: member.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id],
    });
    if (!admission) throw new Error("Synthetic Run was not admitted");
    return admission.row;
  };

  it("stops an owned agent Run and reuses one immutable retry successor before restarting", async () => {
    const original = await prepare();
    const stopped = await call(original.shortcode, "cancel");
    expect(stopped.isError).not.toBe(true);
    const persisted = await getDb(ctx.db).query.run.findFirst({
      where: eq(runTable.id, original.id),
    });
    expect(persisted).toMatchObject({
      status: "failed",
      failureCode: "user_cancelled",
    });
    const retried = await call(original.shortcode, "retry");
    expect(retried.isError).not.toBe(true);
    const successor = z
      .object({
        successor: z.object({ publicId: runShortcode, created: z.boolean() }),
      })
      .parse(retried.structuredContent).successor;
    expect(successor.created).toBe(true);
    const replay = await call(original.shortcode, "retry");
    expect(replay.isError).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({
      successor: { publicId: successor.publicId, created: false },
    });
    expect(
      await getDb(ctx.db).query.run.findFirst({
        where: eq(runTable.id, original.id),
      }),
    ).toMatchObject({
      status: "failed",
      failureCode: "user_cancelled",
      endedAt: persisted!.endedAt,
    });
    expect((await call(successor.publicId, "cancel")).isError).not.toBe(true);
    const restarted = await call(successor.publicId, "restart");
    expect(restarted.isError).not.toBe(true);
    const next = z
      .object({ successor: z.object({ publicId: runShortcode }) })
      .parse(restarted.structuredContent).successor;
    expect(next.publicId).not.toBe(successor.publicId);
    const nextRow = await getDb(ctx.db).query.run.findFirst({
      where: eq(runTable.shortcode, next.publicId),
    });
    const previous = await getDb(ctx.db).query.run.findFirst({
      where: eq(runTable.shortcode, successor.publicId),
    });
    expect(nextRow?.predecessorRunId).toBe(previous?.id);
  });

  it("refuses foreign ownership before changing a Run", async () => {
    const original = await prepare();
    const foreignUserId = userId.parse(crypto.randomUUID());
    await getDb(ctx.db).insert(user).values({
      id: foreignUserId,
      name: "Synthetic other member",
      email: "other@example.test",
    });
    const foreign = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic other member",
      kind: "member",
      userId: foreignUserId,
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ ledgerPartyId: foreign.id, actorUserId: foreignUserId })
      .where(eq(runTable.id, original.id));
    expect((await call(original.shortcode, "cancel")).isError).toBe(true);
    expect(
      await getDb(ctx.db).query.run.findFirst({
        where: eq(runTable.id, original.id),
      }),
    ).toMatchObject({ status: "running" });
  });
});

// Failure modes: paid execution approval or discovery is unreachable through
// MCP; an MCP caller without a member link, or naming a mailbox it does not
// own, writes a grant or launches discovery.
describe("Mail execution approval and discovery through MCP", () => {
  const ctx = withTestDb("mcp");
  const mailboxId = "synthetic-mcp-approval-mailbox";
  const launched: WorkflowRunParams[] = [];

  beforeEach(() => {
    launched.length = 0;
    setCfEnv(
      fromPartial<Env>({
        MAIL_DISCOVERY: {
          create: async (options: {
            id?: string;
            params?: WorkflowRunParams;
          }) => {
            if (!options?.id || !options.params)
              throw new Error("Synthetic Workflow launch needs id and params");
            launched.push(options.params);
            return fromPartial<
              Awaited<ReturnType<Env["MAIL_DISCOVERY"]["create"]>>
            >({ id: options.id });
          },
        },
      }),
    );
  });
  afterEach(() => setCfEnv(undefined));

  const call = (
    tool: string,
    input: Record<string, JSONType>,
    delegatedRunId?: string,
  ) => {
    const request = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    return callMcpTool(createMcpServer(), tool, input, request, {
      entityKernel: entityKernelContextSchema.parse(request),
      ...(delegatedRunId && {
        purchaseAgent: { runId: delegatedRunId, grantId: "synthetic-grant" },
      }),
    });
  };
  const connect = (accountId: string) =>
    getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
  const approval = (mailbox = mailboxId) => ({
    action: "approve_execution",
    scope: {
      kind: "pilot",
      mailboxId: mailbox,
      discovery: "targeted",
      candidateLimit: 60,
      productLimit: 10,
    },
    meteredBudget: { period: "lifetime", limitMicroUSD: 10_000_000 },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  it("issues an execution authorization and starts discovery for an owned mailbox", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic MCP approval member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await connect(mailboxId);
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic MCP discovery vendor",
    });
    expect(
      (await call("imports_read", { action: "execution_mailboxes" }))
        .structuredContent,
    ).toEqual({ mailboxes: [{ mailboxId }] });
    const approved = await call("run", approval());
    expect(approved.isError).not.toBe(true);
    const [root] = await getDb(ctx.db).select().from(runTable);
    expect(executionAuthorizationInput.parse(root?.input)).toMatchObject({
      owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
      scope: { kind: "pilot", mailboxId },
    });
    expect(approved.structuredContent).toMatchObject({ runId: root?.id });

    const discovered = await call("run", {
      action: "discover_mail",
      mailboxId,
    });
    expect(discovered.isError).not.toBe(true);
    expect(discovered.structuredContent).toEqual({ started: 1, running: 0 });
    expect(launched).toHaveLength(1);
    const [discovery] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.purpose, "mail_discovery"));
    expect(mailboxDiscoveryInput.parse(discovery?.input)).toMatchObject({
      mailboxId,
      executionAuthorization: approved.structuredContent,
    });
  });

  it("refuses a caller without a member link and a mailbox the member does not own", async () => {
    await connect(mailboxId);
    expect((await call("run", approval())).isError).toBe(true);
    expect(
      (await call("run", { action: "discover_mail", mailboxId })).isError,
    ).toBe(true);
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic MCP approval member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    expect(
      (await call("run", approval("synthetic-unowned-mailbox"))).isError,
    ).toBe(true);
    expect(
      (
        await call("run", {
          action: "discover_mail",
          mailboxId: "synthetic-unowned-mailbox",
        })
      ).isError,
    ).toBe(true);
    expect(await getDb(ctx.db).select().from(runTable)).toEqual([]);
    expect(launched).toEqual([]);
  });

  const agentRun = async (purpose?: "mail_import") => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic MCP approval member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    return insertWithShortcode(ctx.db, "run", {
      ...(purpose && { purpose, status: "running" }),
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: party.name,
      actorEmail: "approval@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
      trigger: "manual",
      agentSessionId: "synthetic-mcp-approval-session",
      // An approval wakes the agent at its admitted dispatch generation.
      dispatchEventId: crypto.randomUUID(),
    });
  };

  it("refuses a Run-delegated agent granting a paid execution budget", async () => {
    const run = await agentRun("mail_import");
    await connect(mailboxId);
    const refused = await call("run", approval(), run.id);
    expect(refused.isError).toBe(true);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.purpose, "background")),
    ).toEqual([]);
  });

  // Replaces the old "lifecycle refuses approve" assertion: approval is now an
  // intended member control on run.lifecycle.
  it("grants an agent Run's pending approval through run.lifecycle", async () => {
    const run = await agentRun();
    const pending = {
      db: ctx.db,
      actor: ctx.actor,
      operationContext: new McpOperationContext(
        requireActor(
          createTestRequestContext(ctx.db, {
            auth: { userId: ctx.actor.userId },
          }),
        ),
      ),
      trusted: { runId: run.id, grantId: "synthetic-grant" },
      toolName: "statement_rows.update",
      args: {
        selector: { source: "synthetic", externalIds: ["row-a"] },
        data: { disposition: "open", dispositionNote: null },
      },
      execution: { runId: run.id, operationId: "synthetic:mcp-approve" },
      run: async () => ({ accepted: true }),
      baseExtra: fromPartial<ToolExtra>({}),
    };
    await expect(executePurchaseAgentMutation(pending)).rejects.toThrow(
      "awaiting exact human approval",
    );
    const approved = await call("run", {
      action: "lifecycle",
      runId: run.shortcode,
      controlAction: "approve",
      operationId: pending.execution.operationId,
    });
    expect(approved.isError).not.toBe(true);
    const [grant] = await getDb(ctx.db)
      .select()
      .from(runApproval)
      .where(eq(runApproval.runId, run.id));
    expect(grant?.state).toBe("granted");
  });
});
