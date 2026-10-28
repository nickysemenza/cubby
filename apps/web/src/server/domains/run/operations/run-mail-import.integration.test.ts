import { userId } from "@cubby/schemas/identifiers";
import { mailboxDiscoveryInput } from "@cubby/schemas/mailbox-research";
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
import { deleteJobs } from "~/server/generic/jobs/jobs.fixtures";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { systemPrincipal } from "~/server/http/authenticate";
import { requireActor } from "~/server/http/request-context";
import { dispatchAs } from "~/server/operation-runtime/browser-operation-dispatch";
import { startOperationDispatchInput } from "~/server/operation-runtime/start-operation-dispatch.contract";
import { createTestRequestContext } from "~/server/testing/request-context";

// Failures: an unauthenticated or foreign toggle; discovery running while the
// switch is off; a launch fanning out to another mailbox or duplicating an
// active Job; Vendor names widening targeted search beyond verified
// senders and website domains. Real PostgreSQL backs every step.
describe("automatic Mail import switch", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));
  const mailboxId = "synthetic-mail-import-mailbox";
  /** The browser endpoint's dispatch, signed in or refused by the Auth step. */
  const invoke = async (member: string, input: JSONType, signedIn = true) =>
    dispatchAs(
      signedIn
        ? systemPrincipal(
            requireActor(
              createTestRequestContext(ctx.db, {
                auth: { userId: ctx.actor.userId },
              }),
            ),
            { channel: "browser", credential: "cookie" },
          )
        : {
            status: 401,
            code: "UNAUTHORIZED",
            message: "Valid bearer token, or session required",
          },
      startOperationDispatchInput.parse({ operation: `run.${member}`, input }),
      new Request("https://cubby.test/api/operations", { method: "POST" }),
    );
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
      data: { mailboxes: [{ mailboxId, enabled: true }] },
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

  it("classifies with import off, queues catch-up on enabling, and replays active discovery", async () => {
    await seed();
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Verified Vendor",
      website: "https://shop.example.test/orders",
      orderEmailSenders: ["orders@example.test"],
    });
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Unresearched Vendor",
    });
    expect(await invoke("discoverMail", { mailboxId })).toMatchObject({
      ok: true,
    });
    const [classification] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "mail_discovery"));
    expect(
      mailboxDiscoveryInput.parse(classification?.input).executionPolicy,
    ).toBe("classification_only");
    await deleteJobs(ctx.db, { kind: "run.execute" });
    await getDb(ctx.db).delete(run);

    await invoke("setMailImport", { mailboxId, enabled: true });
    expect(
      await readJobs(ctx.db, { kind: "maintenance.purchase-discovery" }),
    ).toMatchObject([{ state: "queued" }]);
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
    const [discovery] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "mail_discovery"));
    expect(await readJobs(ctx.db, { kind: "run.execute" })).toMatchObject([
      {
        key: `run:${discovery!.id}`,
        state: "queued",
        runId: discovery!.id,
        input: { runId: discovery!.id, purpose: "mail_discovery" },
      },
    ]);
    const input = mailboxDiscoveryInput.parse(discovery?.input);
    expect(input).toMatchObject({ mailboxId, executionPolicy: "import" });
    expect(input.scopedQueries.map((query) => query.query).sort()).toEqual([
      '"example.test"',
      "from:orders@example.test",
    ]);

    await getDb(ctx.db).delete(run);
    await invoke("setMailImport", { mailboxId, enabled: false });
    expect(await startMailDiscovery(ctx.db)).toEqual({
      started: 1,
      running: 0,
    });
  });
});
