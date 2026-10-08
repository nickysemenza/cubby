import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { userId } from "@cubby/schemas/identifiers";
import {
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
} from "@cubby/schemas/mailbox-research";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";
import type { JSONType } from "zod";

import { setCfEnv } from "~/server/cf-env";
import { account } from "~/server/db/auth.schema";
import { run, user } from "~/server/db/schema";
import {
  startMailDiscovery,
  listMailDiscovery,
} from "~/server/purchase-import/gmail/discovery";
import type { GmailProvider } from "~/server/purchase-import/gmail/types";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createStartOperationRunner } from "~/server/start-operation.server";
import { createTestRequestContext } from "~/server/testing/request-context";
import type { AppSpan } from "~/server/tracing";
import type { WorkflowRunParams } from "~/server/workflow-runs/contract";

import { runHandlers } from "./run.server";

// Failures: unauthenticated approval; client-supplied owner; foreign/disconnected
// mailbox; incomplete or widened grant; request transaction preventing durable
// issuance; pilot accidentally enabling broad history or borrowing monthly money.
// A selected launch must not fan out to another owned/foreign mailbox, expand its
// immutable allowance, reissue approval, or duplicate an already running Workflow.
// The request runner, member lookup, issuer and discovery use real PostgreSQL.
describe("authenticated member execution approval", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));
  const mailboxId = "synthetic-public-approval-mailbox";
  const span: AppSpan = {
    isRecording: false,
    setAttribute: () => undefined,
    setAttributes: () => undefined,
    setError: () => undefined,
    recordException: () => undefined,
  };
  const invoke = async (member: string, input: JSONType, signedIn = true) => {
    const operation = runHandlers.runs[member];
    if (!operation) throw new Error(`Missing public run.${member} operation`);
    const runner = createStartOperationRunner({
      authenticate: async () =>
        requireActor(
          createTestRequestContext(ctx.db, {
            auth: signedIn ? { userId: ctx.actor.userId } : undefined,
          }),
        ),
      observe: async (_definition, _observation, execute) => execute(span),
      markCalendarDirty: () => undefined,
      recordDatabaseWrite: async () => undefined,
    });
    return runner({
      operation: operation.id,
      type: member === "executionMailboxes" ? "query" : "mutation",
      input,
      inputSchema: operation.input,
      outputSchema: operation.output,
      request: { headers: new Headers(), signal: new AbortController().signal },
      run: (context, parsed) =>
        operation.run(
          { ...context, signal: new AbortController().signal },
          parsed,
        ),
    });
  };
  const approval = () => ({
    scope: {
      kind: "pilot",
      mailboxId,
      discovery: "targeted",
      candidateLimit: 60,
      productLimit: 10,
    },
    meteredBudget: { period: "lifetime", limitMicroUSD: 10_000_000 },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const seed = async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic approval member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const foreignUserId = userId.parse(crypto.randomUUID());
    await getDb(ctx.db).insert(user).values({
      id: foreignUserId,
      name: "Synthetic other mailbox owner",
      email: "foreign-approval@example.test",
      emailVerified: false,
    });
    await getDb(ctx.db)
      .insert(account)
      .values([
        {
          id: crypto.randomUUID(),
          accountId: mailboxId,
          providerId: "google",
          userId: ctx.actor.userId,
          updatedAt: new Date(),
        },
        {
          id: crypto.randomUUID(),
          accountId: "synthetic-foreign-mailbox",
          providerId: "google",
          userId: foreignUserId,
          updatedAt: new Date(),
        },
        {
          id: crypto.randomUUID(),
          accountId: "synthetic-other-provider",
          providerId: "github",
          userId: ctx.actor.userId,
          updatedAt: new Date(),
        },
      ]);
    return party;
  };

  it("derives the owner, persists a completed immutable root, and selects targeted discovery without full history", async () => {
    const party = await seed();
    expect(await invoke("executionMailboxes", {})).toEqual({
      ok: true,
      data: { mailboxes: [{ mailboxId }] },
    });
    const input = approval();
    const result = await invoke("approveExecution", input);
    expect(result).toMatchObject({ ok: true });
    const [root] = await getDb(ctx.db).select().from(run);
    expect(root).toMatchObject({
      purpose: "background",
      trigger: "manual",
      status: "completed",
      actorUserId: ctx.actor.userId,
      ledgerPartyId: party.id,
      coordinatorStartedAt: null,
      parentRunId: null,
    });
    expect(root?.endedAt).toBeInstanceOf(Date);
    expect(executionAuthorizationInput.parse(root?.input)).toEqual({
      kind: "execution_authorization",
      version: 1,
      owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
      ...input,
    });
    expect(result).toMatchObject({ ok: true, data: { runId: root?.id } });
    const continuous = await invoke("approveExecution", {
      scope: { kind: "continuous", mailboxId, discovery: "new_mail" },
      meteredBudget: {
        period: "utc_calendar_month",
        limitMicroUSD: 10_000_000,
      },
      expiresAt: input.expiresAt,
    });
    expect(continuous).toMatchObject({ ok: true });
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic approval vendor",
    });
    const launched: WorkflowRunParams[] = [];
    await startMailDiscovery(ctx.db, {
      launcher: {
        create: async (_purpose, _id, params) => {
          launched.push(params);
        },
        terminate: async () => undefined,
        status: async () => ({ state: "running", error: null }),
      },
    });
    expect(launched).toHaveLength(1);
    const [discovery] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "mail_discovery"));
    expect(mailboxDiscoveryInput.parse(discovery?.input)).toMatchObject({
      mailboxId,
      executionAuthorization: result.ok ? result.data : undefined,
    });
    const queries: string[] = [];
    const provider: GmailProvider = {
      getProfile: async () => ({ historyId: "100" }),
      listMessages: async ({ query }) => {
        queries.push(query);
        return {};
      },
      listHistory: async () => {
        throw new Error("Pilot cannot read incremental history");
      },
      getMessage: async () => {
        throw new Error("Empty pilot cannot fetch originals");
      },
      getAttachment: async () => {
        throw new Error("Empty pilot cannot fetch attachments");
      },
    };
    expect(
      await listMailDiscovery(ctx.db, launched[0]!, {
        providerForUser: async () => provider,
      }),
    ).toMatchObject({ kind: "listed" });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("Synthetic approval vendor");
    const [listed] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "mail_discovery"));
    expect(
      mailboxDiscoveryProgress.parse(listed?.progress).page?.nextCoverage.broad,
    ).toEqual({ pageToken: null, completed: false });
    expect(
      (await getDb(ctx.db).select().from(run)).filter(
        (row) =>
          executionAuthorizationInput.safeParse(row.input).data?.scope.kind ===
          "backfill",
      ),
    ).toEqual([]);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, root!.id)))[0]
        ?.input,
    ).toEqual(root?.input);
  });

  it("rejects unauthenticated requests, forged owners, foreign mailboxes and disconnected selections without writing grants", async () => {
    await seed();
    expect(await invoke("approveExecution", approval(), false)).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    expect(await invoke("executionMailboxes", {}, false)).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    for (const input of [
      {
        ...approval(),
        owner: { userId: ctx.actor.userId, ledgerPartyId: crypto.randomUUID() },
      },
      {
        ...approval(),
        scope: { ...approval().scope, mailboxId: "synthetic-foreign-mailbox" },
      },
      {
        ...approval(),
        scope: {
          ...approval().scope,
          mailboxId: "synthetic-disconnected-mailbox",
        },
      },
      {
        ...approval(),
        scope: { ...approval().scope, mailboxId: "synthetic-other-provider" },
      },
      {
        ...approval(),
        scope: { ...approval().scope, discovery: "all_history" },
      },
      {
        ...approval(),
        meteredBudget: {
          period: "utc_calendar_month",
          limitMicroUSD: 10_000_000,
        },
      },
      { ...approval(), expiresAt: "2020-01-01T00:00:00.000Z" },
      { scope: approval().scope, expiresAt: approval().expiresAt },
    ])
      expect(await invoke("approveExecution", input)).toMatchObject({
        ok: false,
      });
    expect(await getDb(ctx.db).select().from(run)).toEqual([]);
  });

  it("requires a live member link even when the login owns a connected mailbox", async () => {
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    expect(await invoke("executionMailboxes", {})).toMatchObject({ ok: false });
    expect(await invoke("approveExecution", approval())).toMatchObject({
      ok: false,
    });
    expect(await getDb(ctx.db).select().from(run)).toEqual([]);
  });

  it("launches only the selected owned mailbox under its pilot and replays an active launch without widening or reissuing", async () => {
    await seed();
    const [foreign] = await getDb(ctx.db)
      .select()
      .from(account)
      .where(eq(account.accountId, "synthetic-foreign-mailbox"));
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic foreign discovery member",
      kind: "member",
      userId: foreign!.userId,
    });
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: "synthetic-second-owned-mailbox",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic selected launch vendor",
    });
    const approvalResult = await invoke("approveExecution", approval());
    expect(approvalResult).toMatchObject({ ok: true });
    const launched: WorkflowRunParams[] = [];
    setCfEnv(
      fromPartial<Env>({
        MAIL_DISCOVERY: {
          create: async ({ id, params }) => {
            launched.push(params!);
            return fromPartial<WorkflowInstance>({ id: id! });
          },
        },
      }),
    );
    for (const selected of [
      "synthetic-foreign-mailbox",
      "synthetic-disconnected-mailbox",
    ])
      expect(
        await invoke("discoverMail", { mailboxId: selected }),
      ).toMatchObject({ ok: false });
    expect(await invoke("discoverMail", { mailboxId }, false)).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    expect(
      await invoke("discoverMail", { mailboxId, discovery: "all_history" }),
    ).toMatchObject({ ok: false });
    expect(launched).toEqual([]);
    expect(await invoke("discoverMail", { mailboxId })).toEqual({
      ok: true,
      data: { started: 1, running: 0 },
    });
    expect(await invoke("discoverMail", { mailboxId })).toEqual({
      ok: true,
      data: { started: 0, running: 1 },
    });
    expect(launched).toHaveLength(1);
    const discoveries = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "mail_discovery"));
    expect(discoveries).toHaveLength(1);
    expect(mailboxDiscoveryInput.parse(discoveries[0]?.input)).toMatchObject({
      mailboxId,
      executionAuthorization: approvalResult.ok
        ? approvalResult.data
        : undefined,
    });
    expect(
      (await getDb(ctx.db).select().from(run)).filter(
        (row) => executionAuthorizationInput.safeParse(row.input).success,
      ),
    ).toHaveLength(1);
  });
});
