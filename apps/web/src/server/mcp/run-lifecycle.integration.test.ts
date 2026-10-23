import { runShortcode, userId } from "@cubby/schemas/identifiers";
import { mailboxDiscoveryInput } from "@cubby/schemas/mailbox-research";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type JSONType, z } from "zod";

import { setCfEnv } from "~/server/cf-env";
import { account, user } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import {
  aiUsage,
  appSettings,
  job,
  runApproval,
  runControlEvent,
  run as runTable,
} from "~/server/db/schema";
import { retainedMailFixture } from "~/server/domains/purchase-import/operations/order-import.fixtures";
import { admitMailImport } from "~/server/domains/purchase-import/repo/mail-import-run";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { requireActor } from "~/server/http/request-context";
import { createMcpServer } from "~/server/mcp/server";
import { createTestRequestContext } from "~/server/testing/request-context";

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
    setCfEnv(fromPartial<Env>({}));
  });
  afterEach(() => setCfEnv(undefined));

  const call = async (
    runId: string,
    controlAction: string,
    extra: Record<string, JSONType> = {},
  ) => {
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
        ...extra,
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

  // Failure modes: a waiting background Run cannot be released with paid
  // models; the release pays past a spent paid budget without a named amount;
  // the grant is not recorded against the member.
  it("runs a waiting Mail import now with paid models, past a spent budget only by a named amount", async () => {
    const original = await prepare();
    await getDb(ctx.db)
      .update(runTable)
      .set({
        trigger: "discovery",
        status: "paused_auth",
        failureCode: "execution_limit",
      })
      .where(eq(runTable.id, original.id));
    const released = await call(original.shortcode, "run_now_paid");
    expect(released.isError).not.toBe(true);
    expect(released.structuredContent).toMatchObject({
      run: { status: "running" },
    });

    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "paused_auth", failureCode: "execution_limit" })
      .where(eq(runTable.id, original.id));
    await getDb(ctx.db).insert(aiUsage).values({
      runId: original.id,
      feature: "purchase_import_agent",
      provider: "openai",
      model: "gpt-6-sol",
      operation: "agent.generation",
      durationMs: 1,
      chargedCost: 1.05,
      standardCost: 1.05,
    });
    const refused = await call(original.shortcode, "run_now_paid");
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(
      "The paid AI budget is spent: $1.05 of $1.00",
    );
    const confirmed = await call(original.shortcode, "run_now_paid", {
      paidOverBudgetUsd: 1,
    });
    expect(confirmed.isError).not.toBe(true);
    expect(
      await getDb(ctx.db)
        .select({
          action: runControlEvent.action,
          paidOverBudgetUsd: runControlEvent.paidOverBudgetUsd,
          controllerUserId: runControlEvent.controllerUserId,
        })
        .from(runControlEvent)
        .where(eq(runControlEvent.runId, original.id))
        .orderBy(runControlEvent.createdAt),
    ).toEqual([
      {
        action: "run_now_paid",
        paidOverBudgetUsd: null,
        controllerUserId: ctx.actor.userId,
      },
      {
        action: "run_now_paid",
        paidOverBudgetUsd: 1,
        controllerUserId: ctx.actor.userId,
      },
    ]);
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

// Failure modes: the Mail import switch or discovery is unreachable through
// MCP; an MCP caller without a member link, naming a mailbox it does not own,
// or acting as a delegated agent turns import on or launches discovery.
describe("Mail import switch and discovery through MCP", () => {
  const ctx = withTestDb("mcp");
  const mailboxId = "synthetic-mcp-approval-mailbox";
  const CONSOLE_LIMIT =
    '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2099-11-01 at 00:00 UTC."}}';
  // The egress Durable Object's credit refusal, as funding reads see it.
  let creditRefusal: { until: number; reason: string } | null = null;

  beforeEach(() => {
    creditRefusal = null;
    setCfEnv(
      fromPartial<Env>({
        AI_GATEWAY_EGRESS: {
          getByName: () => ({
            creditRefusal: async () => creditRefusal,
            resetCreditRefusal: async () => {
              creditRefusal = null;
            },
          }),
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
  const enable = (mailbox = mailboxId) => ({
    action: "set_mail_import",
    mailboxId: mailbox,
    enabled: true,
  });

  it("turns Mail import on and starts discovery for an owned mailbox", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic MCP approval member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await connect(mailboxId);
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic MCP discovery vendor",
    });
    expect(
      (await call("run", { action: "mail_import" })).structuredContent,
    ).toMatchObject({ mailboxes: [{ mailboxId, enabled: false }] });
    expect(
      (
        await call("run", {
          action: "discover_mail",
          mailboxId,
        })
      ).isError,
    ).toBe(true);
    const enabled = await call("run", enable());
    expect(enabled.isError).not.toBe(true);
    expect(enabled.structuredContent).toMatchObject({
      mailboxes: [{ mailboxId, enabled: true }],
    });

    const discovered = await call("run", {
      action: "discover_mail",
      mailboxId,
    });
    expect(discovered.isError).not.toBe(true);
    expect(discovered.structuredContent).toEqual({ started: 1, running: 0 });
    const [discovery] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.purpose, "mail_discovery"));
    expect(mailboxDiscoveryInput.parse(discovery?.input)).toMatchObject({
      mailboxId,
      executionPolicy: "import",
    });
    if (!discovery) throw new Error("Expected discovery Run");
    expect(
      await getDb(ctx.db)
        .select({ state: job.state, input: job.input })
        .from(job)
        .where(eq(job.key, `run:${discovery.id}`)),
    ).toEqual([
      {
        state: "queued",
        input: { runId: discovery.id, purpose: "mail_discovery" },
      },
    ]);
  });

  // Failure modes: household funding (budgets, a recorded credit refusal with
  // its raw reason, the plan state) is missing from MCP; the credit budget
  // cannot be changed, or changing it leaves Claude credit refused; the
  // refusal cannot be reset; "Run discovery now, paid allowed" starts
  // discovery without recording the member's paid grant.
  it("reports household funding, resets a credit refusal, sets the credit budget, and grants paid discovery", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic MCP approval member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await connect(mailboxId);
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic MCP discovery vendor",
    });
    const until = Date.parse("2099-11-01T00:00:00Z");
    creditRefusal = { until, reason: CONSOLE_LIMIT };
    expect(
      (await call("ai_funding", { action: "status" })).structuredContent,
    ).toMatchObject({
      credit: {
        limitUsd: 1.5,
        spentUsd: 0,
        state: "refused",
        until: "2099-11-01T00:00:00.000Z",
        reason: CONSOLE_LIMIT,
      },
      paid: { limitUsd: 1, spentUsd: 0 },
      plan: { limitUsd: 2, spentUsd: 0, state: "disconnected", until: null },
    });
    expect(
      (await call("run", { action: "mail_import" })).structuredContent,
    ).not.toHaveProperty("budget");
    const reset = await call("ai_funding", { action: "reset_credit_refusal" });
    expect(reset.isError).not.toBe(true);
    expect(reset.structuredContent).toMatchObject({
      credit: { state: "available", until: null, reason: null },
    });
    creditRefusal = { until, reason: CONSOLE_LIMIT };
    const set = await call("ai_funding", {
      action: "set_credit_budget",
      creditLimitUsd: 7.5,
      planLimitUsd: 4,
      paidLimitUsd: 3,
    });
    expect(set.isError).not.toBe(true);
    expect(set.structuredContent).toMatchObject({
      credit: { limitUsd: 7.5, state: "available" },
      plan: { limitUsd: 4 },
      paid: { limitUsd: 3 },
    });
    expect(creditRefusal).toBeNull();
    expect((await call("run", { action: "set_credit_budget" })).isError).toBe(
      true,
    );
    expect((await call("run", enable())).isError).not.toBe(true);
    const discovered = await call("run", {
      action: "discover_mail",
      mailboxId,
      paidAllowed: true,
    });
    expect(discovered.isError).not.toBe(true);
    expect(discovered.structuredContent).toEqual({ started: 1, running: 0 });
    const [discovery] = await getDb(ctx.db)
      .select({ id: runTable.id })
      .from(runTable)
      .where(eq(runTable.purpose, "mail_discovery"));
    expect(
      await getDb(ctx.db)
        .select({ action: runControlEvent.action })
        .from(runControlEvent)
        .where(eq(runControlEvent.runId, discovery!.id)),
    ).toEqual([{ action: "run_now_paid" }]);
  });

  it("refuses a caller without a member link and a mailbox the member does not own", async () => {
    await connect(mailboxId);
    expect((await call("run", enable())).isError).toBe(true);
    expect(
      (await call("run", { action: "discover_mail", mailboxId })).isError,
    ).toBe(true);
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic MCP approval member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    expect(
      (await call("run", enable("synthetic-unowned-mailbox"))).isError,
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
    expect(
      await getDb(ctx.db).select().from(job).where(eq(job.kind, "run.execute")),
    ).toEqual([]);
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

  it("refuses a Run-delegated agent turning on Mail import", async () => {
    const run = await agentRun("mail_import");
    await connect(mailboxId);
    const refused = await call("run", enable(), run.id);
    expect(refused.isError).toBe(true);
    expect(await getDb(ctx.db).select().from(appSettings)).toEqual([]);
  });

  it("executes permitted agent work without an approval lifecycle call", async () => {
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
      toolName: "entity.update",
      args: {
        entity: "sourceTransactionRecord",
        id: "STR-ABCDE",
        data: { disposition: "open", dispositionNote: null },
      },
      execution: { runId: run.id, operationId: "synthetic:mcp-approve" },
      run: async () => ({ accepted: true }),
      baseExtra: fromPartial<ToolExtra>({}),
    };
    await expect(executePurchaseAgentMutation(pending)).resolves.toEqual({
      accepted: true,
    });
    const [grant] = await getDb(ctx.db)
      .select()
      .from(runApproval)
      .where(eq(runApproval.runId, run.id));
    expect(grant).toBeUndefined();
  });
});
