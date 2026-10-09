import {
  executionAuthorizationInput,
  executionAuthorizationReceipt,
} from "@cubby/schemas/execution-authorization";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { account } from "~/server/db/auth.schema";
import {
  importSourceClaim,
  mailboxMessage,
  orderMail,
  run,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";
import { issueExecutionAuthorization } from "~/server/runs/execution-authorization";

import { startMailDiscovery } from "./gmail/discovery";
import { ingestGmailMessages } from "./gmail/ingest";
import type { GmailProvider } from "./gmail/types";
import { startProductResearch } from "./product-research-run";
import { researchServiceFor } from "./research-service";

// Consumption must precede content classification or Product exposure, survive
// cross-Run admission, and count a replayed original/Product only once.
describe("execution limits at real ingestion and research boundaries", () => {
  const ctx = withTestDb();
  const mailboxId = "synthetic-bounded-pilot-mailbox";

  async function approvedPilot() {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic bounded pilot member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      providerId: "google",
      accountId: mailboxId,
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const approval = await issueExecutionAuthorization(
      ctx.db,
      ctx.actor,
      executionAuthorizationInput.parse({
        kind: "execution_authorization",
        version: 1,
        owner: { userId: ctx.actor.userId, ledgerPartyId: member.id },
        scope: {
          kind: "pilot",
          mailboxId,
          discovery: "targeted",
          candidateLimit: 1,
          productLimit: 1,
        },
        meteredBudget: { period: "lifetime", limitMicroUSD: 1_000_000 },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const parentRunId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "manual",
      status: "running",
      input: {
        mailboxId,
        scopedQueries: [],
        executionAuthorization: approval,
      },
    });
    return { member, approval, parentRunId };
  }

  async function claimsFor(rootId: typeof run.$inferSelect.id) {
    const rows = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, rootId));
    return rows
      .map((row) => executionAuthorizationReceipt.parse(row.result))
      .filter((receipt) => receipt.kind === "claim");
  }

  it.each([false, true])(
    "resumes an offline Product before exposing cloud work (bounded=%s)",
    async (bounded) => {
      const f = await approvedPilot();
      const item = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic offline cloud fan" }),
        ctx.actor,
      );
      const [started] = await startProductResearch(
        ctx.db,
        {
          ledgerPartyId: f.member.id,
          userId: ctx.actor.userId,
          parentRunId: bounded ? f.parentRunId : undefined,
          productIds: [item.entityId],
          cause: "member_request",
        },
        { send: async () => {} },
      );
      if (!started) throw new Error("Synthetic Product admission missing");
      await getDb(ctx.db)
        .update(run)
        .set({ status: "paused_offline" })
        .where(eq(run.id, started.runId));
      const services = researchServiceFor(
        ctx.db,
        fromPartial<Env>({}),
        started.runId,
      );
      expect(
        await services.researchNext({}, crypto.randomUUID()),
      ).toMatchObject({
        status: "working",
        work: { kind: "product", product: { productRef: item.id } },
      });
      const [persisted] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, started.runId));
      expect(persisted?.status).toBe("running");
      expect(
        (await claimsFor(f.approval.runId)).map((receipt) => receipt.claim),
      ).toEqual(bounded ? [{ kind: "product", productId: item.entityId }] : []);
    },
  );

  it("never classifies or retains a second distinct positive candidate after replaying the first", async () => {
    const f = await approvedPilot();
    const classified: string[] = [];
    const gmail: GmailProvider = {
      getProfile: async () => ({ historyId: "100" }),
      listMessages: async () => ({}),
      listHistory: async () => ({}),
      getAttachment: async () => {
        throw new Error("Plain-text fixture has no attachment.");
      },
      getMessage: async (id) => ({
        id,
        internalDate: "1788220800000",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "orders@synthetic-shop.example.test" },
            { name: "Subject", value: `Synthetic purchase ${id}` },
          ],
          body: {
            data: Buffer.from(
              `Order ${id}: one synthetic device, total USD 24.`,
            ).toString("base64url"),
          },
        },
      }),
    };
    const ingest = (messageId: string) =>
      ingestGmailMessages(ctx.db, gmail, {
        ledgerPartyId: f.member.id,
        mailboxId,
        runId: f.parentRunId,
        messageIds: [messageId],
        triage: async (content) => {
          classified.push(content);
          return "related";
        },
      });
    const first = await ingest("synthetic-first-candidate");
    expect(first.saved).toEqual(["synthetic-first-candidate"]);
    expect(first.orderMailIds).toHaveLength(1);
    expect((await ingest("synthetic-first-candidate")).orderMailIds).toEqual(
      first.orderMailIds,
    );
    expect(classified).toHaveLength(1);
    const original = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.id, first.orderMailIds[0]!));

    await expect(ingest("synthetic-second-candidate")).rejects.toThrow(
      /candidate_limit/u,
    );

    expect(classified).toHaveLength(1);
    expect(
      await getDb(ctx.db)
        .select()
        .from(orderMail)
        .where(eq(orderMail.ledgerPartyId, f.member.id)),
    ).toEqual(original);
    expect(
      await getDb(ctx.db)
        .select()
        .from(importSourceClaim)
        .where(eq(importSourceClaim.ledgerPartyId, f.member.id)),
    ).toEqual([]);
    const originals = await getDb(ctx.db)
      .select()
      .from(mailboxMessage)
      .where(
        and(
          eq(mailboxMessage.ledgerPartyId, f.member.id),
          eq(mailboxMessage.mailboxId, mailboxId),
        ),
      );
    expect(
      originals.filter(
        (row) =>
          row.messageId === "synthetic-second-candidate" &&
          row.classification === "related",
      ),
    ).toEqual([]);
    expect(
      (await claimsFor(f.approval.runId)).map((receipt) => receipt.claim),
    ).toEqual([
      { kind: "candidate", mailboxId, messageId: "synthetic-first-candidate" },
    ]);
    const launched: string[] = [];
    expect(
      await startMailDiscovery(ctx.db, {
        launcher: {
          create: async (_purpose, id) => {
            launched.push(id);
          },
          terminate: async () => undefined,
          status: async () => ({ state: "running", error: null }),
        },
      }),
    ).toEqual({ started: 0, running: 0 });
    expect(launched).toEqual([]);
  });

  it("never exposes a second distinct Product across admitted Runs while first-Product Next replay remains usable", async () => {
    const f = await approvedPilot();
    const first = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic first pilot Product",
        manufacturer: "Synthetic Works",
        model: "",
      }),
      ctx.actor,
    );
    const second = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic second pilot Product",
        manufacturer: "Synthetic Works",
        model: "",
      }),
      ctx.actor,
    );
    const start = async (productId: typeof first.entityId) => {
      const [started] = await startProductResearch(
        ctx.db,
        {
          ledgerPartyId: f.member.id,
          userId: ctx.actor.userId,
          parentRunId: f.parentRunId,
          productIds: [productId],
          cause: "member_request",
        },
        { send: async () => {} },
      );
      if (!started)
        throw new Error("Synthetic current Product admission missing.");
      return started.runId;
    };
    const firstRunId = await start(first.entityId);
    const secondRunId = await start(second.entityId);
    const admitted = await getDb(ctx.db)
      .select({ input: run.input })
      .from(run)
      .where(eq(run.id, secondRunId));
    expect(admitted[0]?.input).toMatchObject({
      kind: "product_research",
      executionAuthorization: f.approval,
    });
    const services = (runId: typeof firstRunId) =>
      researchServiceFor(ctx.db, fromPartial<Env>({}), runId);
    const firstServices = services(firstRunId);
    const callId = crypto.randomUUID();
    const firstWork = await firstServices.researchNext({}, callId);
    expect(firstWork).toMatchObject({
      status: "working",
      work: { kind: "product", product: { productRef: first.id } },
    });
    expect(await firstServices.researchNext({}, callId)).toEqual(firstWork);
    expect(await firstServices.researchNext({}, crypto.randomUUID())).toEqual(
      firstWork,
    );
    const beforeTargets = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, secondRunId));
    const secondServices = services(secondRunId);

    expect(
      await secondServices.researchNext({}, crypto.randomUUID()),
    ).toMatchObject({ status: "stopped", reason: "product_limit" });

    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, secondRunId)),
    ).toEqual(beforeTargets);
    const [limitedRun] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, secondRunId));
    expect(limitedRun?.status).toBe("needs_review");
    expect(
      (await claimsFor(f.approval.runId)).map((receipt) => receipt.claim),
    ).toEqual([{ kind: "product", productId: first.entityId }]);
  });
});
