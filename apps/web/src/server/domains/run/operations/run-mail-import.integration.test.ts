import { userId } from "@cubby/schemas/identifiers";
import { mailboxDiscoveryInput } from "@cubby/schemas/mailbox-research";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";
import type { JSONType } from "zod";

import { setCfEnv } from "~/server/cf-env";
import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { appSettings, run, user } from "~/server/db/schema";
import { startMailDiscovery } from "~/server/domains/purchase-import/operations/gmail/discovery";
import { checkpointMailboxCoverage } from "~/server/domains/purchase-import/repo/gmail/persistence";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { requireActor } from "~/server/http/request-context";
import type { AppSpan } from "~/server/observability/tracing";
import { createStartOperationRunner } from "~/server/operation-runtime/start-operation.server";
import { createTestRequestContext } from "~/server/testing/request-context";
import type { WorkflowRunParams } from "~/server/workflows/runs/contract";

import { runHandlers } from "./run.server";

// Failures: an unauthenticated or foreign toggle; discovery running while the
// switch is off; a launch fanning out to another mailbox or duplicating an
// active Workflow; Vendor names widening targeted search beyond verified
// senders and website domains. Real PostgreSQL backs every step.
describe("automatic Mail import switch", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));
  const mailboxId = "synthetic-mail-import-mailbox";
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
      type: member === "mailImport" ? "query" : "mutation",
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
  const seed = async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic Mail import member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const foreignUserId = userId.parse(crypto.randomUUID());
    await getDb(ctx.db).insert(user).values({
      id: foreignUserId,
      name: "Synthetic other mailbox owner",
      email: "foreign-mail-import@example.test",
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

  const launches = () => {
    const launched: WorkflowRunParams[] = [];
    setCfEnv(
      fromPartial<Env>({
        MAIL_DISCOVERY: {
          create: async (options: {
            id?: string;
            params?: WorkflowRunParams;
          }) => {
            if (!options?.id || !options.params)
              throw new Error(
                "Synthetic Workflow launch requires id and params",
              );
            launched.push(options.params);
            return fromPartial<
              Awaited<ReturnType<Env["MAIL_DISCOVERY"]["create"]>>
            >({ id: options.id });
          },
        },
      }),
    );
    return launched;
  };

  it("toggles only the member's connected Gmail mailboxes", async () => {
    await seed();
    for (const member of ["mailImport", "setMailImport"])
      expect(
        await invoke(
          member,
          member === "mailImport" ? {} : { mailboxId, enabled: true },
          false,
        ),
      ).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    for (const selected of [
      "synthetic-foreign-mailbox",
      "synthetic-disconnected-mailbox",
      "synthetic-other-provider",
    ])
      expect(
        await invoke("setMailImport", { mailboxId: selected, enabled: true }),
      ).toMatchObject({ ok: false });
    expect(await getDb(ctx.db).select().from(appSettings)).toEqual([]);
    expect(
      await invoke("setMailImport", { mailboxId, enabled: true }),
    ).toMatchObject({
      ok: true,
      data: {
        mailboxes: [{ mailboxId, enabled: true }],
        budget: {
          credit: { limitUsd: 5, spentUsd: 0 },
          paid: { limitUsd: 1, spentUsd: 0 },
        },
      },
    });
    expect(await invoke("mailImport", {})).toMatchObject({
      ok: true,
      data: { mailboxes: [{ mailboxId, enabled: true }] },
    });
  });

  it("reports each mailbox's current searches, ignoring stale entries", async () => {
    const party = await seed();
    const verified = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Searched Vendor",
      orderEmailSenders: ["orders@searched.example.test"],
    });
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Queued Vendor",
      orderEmailSenders: ["orders@queued.example.test"],
    });
    const searched = {
      key: `vendor:${verified.id}:from:orders@searched.example.test`,
      query: "from:orders@searched.example.test",
    };
    await checkpointMailboxCoverage(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId,
      from: null,
      to: {
        version: 1,
        baselineHistoryId: "100",
        broad: { pageToken: null, completed: false },
        scoped: [
          { ...searched, pageToken: "page-2", completed: false },
          // Finished searches whose targets are gone stay out of the totals.
          {
            key: "merchant:retired synthetic shop",
            query: '"retired synthetic shop"',
            pageToken: null,
            completed: true,
          },
        ],
        history: { historyId: "100", pageToken: null, targetHistoryId: null },
        nextLane: "scan",
      },
    });
    expect(await invoke("mailImport", {})).toMatchObject({
      ok: true,
      data: {
        mailboxes: [
          {
            mailboxId,
            enabled: false,
            searches: {
              vendors: { completed: 0, total: 2 },
              charges: { completed: 0, total: 0 },
              inProgress: searched,
              nextPending: [{ query: "from:orders@queued.example.test" }],
            },
          },
        ],
      },
    });
  });

  it("discovers only with the switch on, imports, and replays an active launch", async () => {
    await seed();
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Verified Vendor",
      website: "https://shop.example.test/orders",
      orderEmailSenders: ["orders@example.test"],
    });
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Unresearched Vendor",
    });
    const launched = launches();
    expect(await invoke("discoverMail", { mailboxId })).toMatchObject({
      ok: false,
    });
    expect(await startMailDiscovery(ctx.db)).toEqual({
      started: 0,
      running: 0,
    });
    expect(launched).toEqual([]);

    await invoke("setMailImport", { mailboxId, enabled: true });
    expect(
      await invoke("discoverMail", { mailboxId: "synthetic-foreign-mailbox" }),
    ).toMatchObject({ ok: false });
    expect(await invoke("discoverMail", { mailboxId })).toEqual({
      ok: true,
      data: { started: 1, running: 0 },
    });
    expect(await invoke("discoverMail", { mailboxId })).toEqual({
      ok: true,
      data: { started: 0, running: 1 },
    });
    expect(launched).toHaveLength(1);
    const [discovery] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "mail_discovery"));
    const input = mailboxDiscoveryInput.parse(discovery?.input);
    expect(input).toMatchObject({ mailboxId, executionPolicy: "import" });
    expect(input.scopedQueries.map((query) => query.query).sort()).toEqual([
      '"example.test"',
      "from:orders@example.test",
    ]);

    await getDb(ctx.db).delete(run);
    await invoke("setMailImport", { mailboxId, enabled: false });
    expect(await startMailDiscovery(ctx.db)).toEqual({
      started: 0,
      running: 0,
    });
  });
});
