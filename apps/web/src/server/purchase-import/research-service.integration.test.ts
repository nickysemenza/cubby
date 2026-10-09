import { parseEntityId } from "@cubby/schemas/identifiers";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runContract } from "~/contracts/run.contract";
import {
  mailboxMessage,
  orderMail,
  run,
  runEvidence,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { recordAcceptedFactEvidence } from "./fact-verification";
import { resolveImportResearch } from "./research-import";
import { startMailResearch } from "./research-run";
import { researchServiceFor } from "./research-service";
import { loadRunDetail, loadRunLog } from "./run-service";

// System boundaries: no Mac/known vendor prerequisite, automatic task-bound
// source retention, completion with unresolved work never claiming success,
// and legacy conversations never executing new tools or replaying old results.
describe("research host lifecycle", () => {
  const ctx = withTestDb();
  async function admitted(messageCount = 1) {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Example cloud research member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        mailboxId: "synthetic-cloud-mailbox",
        messageId: "synthetic-cloud-message",
        sender: "orders@unknown-shop.example",
        subject: "Example receipt",
        rawChecksum: "a".repeat(64),
        receivedAt: new Date("2026-09-01T12:00:00Z"),
        content: {
          snippet: null,
          bodyText: "Order EXAMPLE-100: one small device, total $24",
          bodyHtml: null,
        },
      })
      .returning();
    if (!mail) throw new Error("Synthetic receipt missing");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: party.id,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
      checksum: mail.rawChecksum,
      classification: "related",
      classificationVersion: "synthetic-v1",
      status: "pending",
      orderMailId: mail.id,
    });
    const messageIds = [mail.id];
    for (let index = 1; index < messageCount; index++) {
      const [other] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ...mail,
          id: crypto.randomUUID(),
          messageId: `synthetic-cloud-message-${index}`,
        })
        .returning();
      if (!other) throw new Error("Synthetic selected receipt missing");
      await getDb(ctx.db).insert(mailboxMessage).values({
        ledgerPartyId: party.id,
        mailboxId: other.mailboxId,
        messageId: other.messageId,
        checksum: other.rawChecksum,
        classification: "related",
        classificationVersion: "synthetic-v1",
        status: "pending",
        orderMailId: other.id,
      });
      messageIds.push(other.id);
    }
    const [started] = await startMailResearch(
      ctx.db,
      {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        mailboxId: mail.mailboxId,
        messageIds,
      },
      { send: async () => {} },
    );
    if (!started) throw new Error("Synthetic Run missing");
    const bytes = new Map<string, Uint8Array>();
    const queued: PurchaseAgentEvent[] = [];
    const services = researchServiceFor(
      ctx.db,
      fromPartial<Env>({ R2_KEY_PREFIX: "synthetic/research" }),
      started.runId,
      {
        queue: {
          send: async (event: PurchaseAgentEvent) => {
            queued.push(event);
          },
        },
        observations: {
          keyPrefix: "synthetic/research",
          storage: {
            put: async (key, data) => {
              bytes.set(key, data);
            },
            get: async (key) => {
              const data = bytes.get(key);
              if (!data) throw new Error("Synthetic retained bytes missing");
              return new TextDecoder().decode(data);
            },
          },
        },
      },
    );
    return { party, mail, started, services, bytes, queued };
  }
  it.each([
    "missing inputs",
    "legacy mail",
    "legacy backfill",
    "legacy charges",
  ])("fences %s before empty work can be reported completed", async (kind) => {
    const f = await admitted();
    const input =
      kind === "legacy mail"
        ? {
            kind: "order_mail_import" as const,
            eventId: f.mail.id,
            evidenceChecksum: f.mail.rawChecksum,
            orderId: "EXAMPLE-100",
          }
        : kind === "legacy backfill"
          ? {
              kind: "order_backfill" as const,
              from: "2025-01-01",
              to: "2025-12-31",
            }
          : kind === "legacy charges"
            ? { kind: "charge_hunts" as const, huntIds: [crypto.randomUUID()] }
            : null;
    await getDb(ctx.db)
      .update(run)
      .set({
        input,
        purpose:
          kind === "missing inputs" ? "product_enrichment" : "account_sync",
      })
      .where(eq(run.id, parseEntityId("run", f.started.runId)));
    await getDb(ctx.db)
      .delete(runTarget)
      .where(eq(runTarget.runId, f.started.runId));
    const [before] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, parseEntityId("run", f.started.runId)));
    await expect(
      f.services.researchNext({}, crypto.randomUUID()),
    ).rejects.toThrow(/legacy.*fresh|requires.*new research/u);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, parseEntityId("run", f.started.runId))),
    ).toEqual([before]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, f.started.runId)),
    ).toEqual([]);
    expect(f.queued).toEqual([]);
  });
  it("fences a legacy conversation before replaying a cached research response", async () => {
    const f = await admitted();
    const callId = crypto.randomUUID();
    expect(await f.services.researchNext({}, callId)).toMatchObject({
      status: "working",
    });
    await getDb(ctx.db)
      .update(run)
      .set({ input: null })
      .where(eq(run.id, parseEntityId("run", f.started.runId)));
    await expect(f.services.researchNext({}, callId)).rejects.toThrow(
      /legacy.*fresh|requires.*new research/u,
    );
    const [header] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, parseEntityId("run", f.started.runId)));
    expect(header?.status).toBe("running");
    expect(header?.input).toBeNull();
  });
  it("finds an existing category by public code even when it has no search document", async () => {
    const f = await admitted();
    const category = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic compact tools",
      parentId: null,
      feature: null,
      emoji: null,
      sortOrder: 0,
      spendingCategoryMode: "inherit",
      spendingCategoryId: null,
    });
    const next = await f.services.researchNext({}, crypto.randomUUID());
    const workRef = z
      .object({ work: z.object({ workRef: z.uuid() }) })
      .parse(next).work.workRef;
    const result = await f.services.researchFind(
      { workRef, entityKind: "productCategory", query: category.shortcode },
      crypto.randomUUID(),
    );
    expect(result).toMatchObject({
      results: [
        {
          entityKind: "productCategory",
          id: category.shortcode,
          name: "Synthetic compact tools",
        },
      ],
    });
  });
  it("refuses current inputs whose task admission is missing instead of reporting success", async () => {
    const f = await admitted();
    await getDb(ctx.db)
      .delete(runTarget)
      .where(eq(runTarget.runId, f.started.runId));
    await expect(
      f.services.researchNext({}, crypto.randomUUID()),
    ).rejects.toThrow(/admission.*incomplete/u);
    const [header] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, parseEntityId("run", f.started.runId)));
    expect(header?.status).toBe("running");
    expect(header?.endedAt).toBeNull();
  });
  async function importPrimary(messageCount: number) {
    const f = await admitted(messageCount);
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(
        and(
          eq(runTarget.runId, f.started.runId),
          eq(runTarget.workKey, f.mail.id),
        ),
      );
    if (!target) throw new Error("Synthetic work missing");
    const observed = z
      .object({ evidenceId: z.uuid() })
      .parse(
        await f.services.researchMailRead(
          { workRef: target.id, messageRef: f.mail.id },
          crypto.randomUUID(),
        ),
      );
    const proposal = researchWorkResolve.parse({
      workRef: target.id,
      status: "verified",
      identity: {
        evidenceIds: [observed.evidenceId],
        reasoning: "The original identifies the purchased small device.",
      },
      orders: [
        {
          vendor: { name: "Example device seller" },
          evidenceIds: [observed.evidenceId],
          reasoning: "The original receipt gives this item and total.",
          candidate: {
            orderId: "EXAMPLE-100",
            orderedAt: "2026-09-01T12:00:00Z",
            merchant: "Example device seller",
            currency: "USD",
            printedGrandTotal: 24,
            lines: [
              {
                title: "Small device",
                amount: 24,
                quantity: 1,
                lineKind: "principal",
              },
            ],
            payments: [],
            allShipmentsDelivered: false,
          },
          productResolutions: [{ kind: "new", lineIndex: 0 }],
        },
      ],
      detail:
        "Imported the supported purchased item; catalog verification remains open.",
    });
    const resolutionCall = crypto.randomUUID();
    const imported = await resolveImportResearch(
      ctx.db,
      {
        runId: f.started.runId,
        workRef: target.id,
        callId: resolutionCall,
        proposal,
      },
      {
        readEvidence: async (row) => {
          const data = f.bytes.get(row.objectKey);
          if (!data) throw new Error("Synthetic source bytes missing");
          return new TextDecoder().decode(data);
        },
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedIdentifierClaims: [],
          acceptedImages: [],
          acceptedOrders: [0],
          acceptedEmailLinks: [],
          rejected: [],
        }),
      },
    );
    const finished = await f.services.researchResolve(proposal, resolutionCall);
    return { f, proposal, resolutionCall, imported, finished };
  }
  async function assertAutomaticChild(
    f: Awaited<ReturnType<typeof admitted>>,
    finished: Awaited<ReturnType<typeof importPrimary>>["finished"],
    messageCount: number,
  ) {
    expect(finished).toMatchObject({
      status: "done",
      summary: { verified: messageCount },
    });
    expect(f.queued).toHaveLength(1);
    const [child] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.parentRunId, parseEntityId("run", f.started.runId)));
    expect(child).toMatchObject({
      purpose: "product_enrichment",
      cause: "import_completed",
      status: "running",
    });
    if (!child) throw new Error("Synthetic Product research child missing");
    expect(
      await researchServiceFor(
        ctx.db,
        fromPartial<Env>({}),
        child.id,
      ).researchNext({}, crypto.randomUUID()),
    ).toMatchObject({
      status: "working",
      work: {
        kind: "product",
        product: { ingredientId: null, growsPlantId: null },
      },
    });
    expect(f.queued).toHaveLength(1);
  }
  it("automatically researches supported imported Products after settlement and replays without duplicate child work", async () => {
    const { f, proposal, resolutionCall, imported, finished } =
      await importPrimary(1);
    expect(imported.productIds).toHaveLength(1);
    expect(finished).toMatchObject({
      resolution: {
        productRefs: [expect.stringMatching(/^PRD-/u)],
        purchaseContext: {
          purchases: [{ purchaseRef: expect.stringMatching(/^PUR-/u) }],
        },
      },
    });
    await assertAutomaticChild(f, finished, 1);
    expect(await f.services.researchResolve(proposal, resolutionCall)).toEqual(
      finished,
    );
    expect(f.queued).toHaveLength(1);
  });
  it("exposes owned committed Purchase context to related mail before search indexing and after task resume", async () => {
    const { f, finished: first } = await importPrimary(2);
    let finished = first;
    expect(finished).toMatchObject({
      resolution: {
        productRefs: [expect.stringMatching(/^PRD-/u)],
        purchaseContext: {
          purchases: [{ purchaseRef: expect.stringMatching(/^PUR-/u) }],
        },
      },
    });
    expect(finished).toMatchObject({
      status: "working",
      work: {
        kind: "mail",
        purchaseContext: {
          incomplete: false,
          purchases: [
            {
              orderId: "EXAMPLE-100",
              vendor: { name: "Example device seller" },
              lines: [{ name: "Small device", cost: 24 }],
            },
          ],
        },
      },
    });
    const next = z
      .object({
        work: z.object({
          workRef: z.uuid(),
          sources: z.array(z.object({ messageRef: z.uuid() })),
          purchaseContext: z.object({
            purchases: z.array(z.object({ purchaseRef: z.string() })),
          }),
        }),
      })
      .parse(finished).work;
    expect(
      await f.services.researchFind(
        { workRef: next.workRef, query: "EXAMPLE-100" },
        crypto.randomUUID(),
      ),
    ).toMatchObject({ results: [] });
    expect(
      await f.services.researchNext({}, crypto.randomUUID()),
    ).toMatchObject({ work: { purchaseContext: next.purchaseContext } });
    expect(finished).not.toHaveProperty("resolution.purchaseIds");
    expect(finished).not.toHaveProperty("resolution.productIds");
    expect(finished).not.toHaveProperty("resolution.eventIds");
    const shipment = z.object({ evidenceId: z.uuid() }).parse(
      await f.services.researchMailRead(
        {
          workRef: next.workRef,
          messageRef: next.sources[0]!.messageRef,
        },
        crypto.randomUUID(),
      ),
    );
    const link = researchWorkResolve.parse({
      workRef: next.workRef,
      status: "verified",
      identity: {
        evidenceIds: [shipment.evidenceId],
        reasoning:
          "The retained related original establishes the same seller and order.",
      },
      emailLinks: [
        {
          purchaseRef: next.purchaseContext.purchases[0]!.purchaseRef,
          evidenceIds: [shipment.evidenceId],
          event: "shipped",
          reasoning: "The primary original supports this order shipment.",
        },
      ],
      detail: "Linked the related original without a second itemized purchase.",
    });
    const linkCall = crypto.randomUUID();
    await resolveImportResearch(
      ctx.db,
      {
        runId: f.started.runId,
        workRef: next.workRef,
        callId: linkCall,
        proposal: link,
      },
      {
        readEvidence: async (row) => {
          const data = f.bytes.get(row.objectKey);
          if (!data) throw new Error("Synthetic source bytes missing");
          return new TextDecoder().decode(data);
        },
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedIdentifierClaims: [],
          acceptedImages: [],
          acceptedOrders: [],
          acceptedEmailLinks: [0],
          rejected: [],
        }),
      },
    );
    finished = await f.services.researchResolve(link, linkCall);
    await assertAutomaticChild(f, finished, 2);
  });
  it("automatically retains mail observations under the explicit work without browser admission", async () => {
    const f = await admitted();
    const work = await f.services.researchNext({}, crypto.randomUUID());
    expect(work).toMatchObject({
      status: "working",
      work: { kind: "mail", sources: [{ messageRef: f.mail.id }] },
    });
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, f.started.runId));
    if (!target) throw new Error("Explicit work missing");
    const callId = crypto.randomUUID();
    const observation = await f.services.researchMailRead(
      { workRef: target.id, messageRef: f.mail.id },
      callId,
    );
    expect(
      await f.services.researchMailRead(
        { workRef: target.id, messageRef: f.mail.id },
        callId,
      ),
    ).toEqual(observation);
    const rows = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.runId, f.started.runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetId: target.id,
      kind: "mail_message",
      sourceMetadata: { orderMailId: f.mail.id, checksum: f.mail.rawChecksum },
    });
    expect(f.bytes.size).toBe(1);
  });

  it("uses bounded source-search transport while retaining task ownership without a Cloudflare AI binding", async () => {
    const f = await admitted();
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, f.started.runId));
    if (!target) throw new Error("Synthetic research target missing");
    const service = researchServiceFor(
      ctx.db,
      fromPartial<Env>({}),
      f.started.runId,
      {
        observations: {
          search: async () =>
            Response.json({
              items: [
                {
                  url: "https://maker.example.test/small-device",
                  title: "Small device",
                  description: "Synthetic catalog source for investigation",
                },
              ],
            }),
        },
      },
    );
    expect(
      await service.researchWebSearch(
        { workRef: target.id, query: "Small device exact model" },
        crypto.randomUUID(),
      ),
    ).toMatchObject({
      results: [
        {
          url: "https://maker.example.test/small-device",
          title: "Small device",
        },
      ],
    });
  });
  it("exposes mail work through the shared Run contract while hiding private provider scope and continuation state", async () => {
    const f = await admitted();
    const [header] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, parseEntityId("run", f.started.runId)));
    if (!header) throw new Error("Synthetic Run missing");
    await getDb(ctx.db)
      .insert(runOperation)
      .values(
        ["scope", "choice", "page", "continuation"].map((kind) => ({
          runId: header.id,
          operationId: `synthetic-private-${kind}`,
          kind: `research_mail_${kind}`,
          inputFingerprint: "b".repeat(64),
          state: "completed" as const,
          result: {
            pageToken: "synthetic-provider-continuation",
            accountRef: "synthetic-private-account",
          },
        })),
      );
    const detail = runContract.ops.work.output.parse(
      await loadRunDetail(ctx.db, header.shortcode),
    );
    expect(detail.targets).toMatchObject([
      { targetType: "run", state: "pending" },
    ]);
    expect(detail.operations).toEqual([]);
    const logs = await loadRunLog(ctx.db, header.shortcode);
    expect(
      logs.entries.map((entry) => entry.operationKind).filter(Boolean),
    ).toEqual([]);
    expect(JSON.stringify({ detail, logs })).not.toContain(
      "synthetic-provider-continuation",
    );
  });
  it.each([
    { outcome: "ambiguous", gapCount: 0 },
    { outcome: "researched_with_gaps", gapCount: 1 },
  ] as const)(
    "automatically ends execution with unresolved $outcome accounting and no finish call",
    async ({ outcome, gapCount }) => {
      const f = await admitted();
      await getDb(ctx.db)
        .update(runTarget)
        .set({
          state: "unresolved",
          outcome,
          warning: "Research remains unresolved with no supported writes.",
        })
        .where(eq(runTarget.runId, f.started.runId));
      expect(
        await f.services.researchNext({}, crypto.randomUUID()),
      ).toMatchObject({
        status: "done",
        summary: {
          verified: 0,
          partiallyVerified: 0,
          researchedWithGaps: gapCount,
          unresolved: 1,
        },
      });
      const [saved] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, parseEntityId("run", f.started.runId)));
      expect(saved?.status).toBe("needs_review");
      expect(saved?.endedAt).toBeInstanceOf(Date);
    },
  );
  // Refusal recovery must upgrade continuing investigation, not a different
  // task after settled ambiguity, and must preserve the existing attempt cap.
  it.each(["correctable", "settled"] as const)(
    "escalates only the same active refused task (%s)",
    async (disposition) => {
      const f = await admitted(2);
      const first = z
        .object({ work: z.object({ workRef: z.uuid() }) })
        .parse(await f.services.researchNext({}, crypto.randomUUID()));
      const [target] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.id, first.work.workRef));
      if (!target?.workKey) throw new Error("Synthetic mail task missing");
      const observed = z
        .object({ evidenceId: z.uuid() })
        .parse(
          await f.services.researchMailRead(
            { workRef: target.id, messageRef: target.workKey },
            crypto.randomUUID(),
          ),
        );
      const proposal = researchWorkResolve.parse({
        workRef: target.id,
        status: disposition === "correctable" ? "verified" : "ambiguous",
        identity: {
          evidenceIds: [observed.evidenceId],
          reasoning: "The source identity needs further investigation.",
        },
        detail: "The receipt is retained; its precise identity is unresolved.",
      });
      for (
        let attempt = 1;
        attempt <= (disposition === "correctable" ? 3 : 1);
        attempt++
      ) {
        const callId = crypto.randomUUID();
        const result = await resolveImportResearch(
          ctx.db,
          { runId: f.started.runId, workRef: target.id, callId, proposal },
          {
            readEvidence: async (row) => {
              const bytes = f.bytes.get(row.objectKey);
              if (!bytes) throw new Error("Synthetic retained source missing");
              return new TextDecoder().decode(bytes);
            },
            assess: async () => ({
              identityVerified: false,
              acceptedFacts: [],
              acceptedIdentifiers: [],
              acceptedImages: [],
              acceptedOrders: [],
              acceptedEmailLinks: [],
              rejected: [
                {
                  path: "proposal.identity.reasoning",
                  reason: "The exact order identity is not established.",
                },
              ],
            }),
          },
        );
        expect(result.refusals.length).toBeGreaterThan(0);
        const response = await f.services.researchResolve(proposal, callId);
        const continuing = disposition === "correctable" && attempt < 3;
        const current = z
          .object({
            status: z.literal("working"),
            work: z.object({ workRef: z.uuid() }),
            reasoningMode: z.literal("unfamiliar_resolution").optional(),
          })
          .parse(response);
        expect(current.work.workRef === target.id).toBe(continuing);
        expect(current.reasoningMode).toBe(
          continuing ? "unfamiliar_resolution" : undefined,
        );
        expect(await f.services.researchResolve(proposal, callId)).toEqual(
          response,
        );
      }
      const [settled] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.id, target.id));
      expect(settled?.state).toBe("unresolved");
    },
  );
  it("leaves a cancelled Run untouched when a late final answer proposes continuation", async () => {
    const f = await admitted();
    await getDb(ctx.db)
      .update(run)
      .set({
        status: "failed",
        failureCode: "user_cancelled",
        endedAt: new Date(),
      })
      .where(eq(run.id, parseEntityId("run", f.started.runId)));
    expect(
      await f.services.researchContinue(crypto.randomUUID(), false),
    ).toMatchObject({ status: "stopped", reason: "failed" });
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, f.started.runId)),
    ).toEqual([]);
  });
  it("does not consume a proposed continuation before pi selects it over queued input or reset", async () => {
    const f = await admitted();
    const calls = Array.from({ length: 3 }, () => crypto.randomUUID());
    for (const callId of calls)
      expect(await f.services.researchContinue(callId, false)).toMatchObject({
        status: "working",
      });
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(
          and(
            eq(runOperation.runId, f.started.runId),
            eq(runOperation.kind, "research_continue"),
          ),
        ),
    ).toEqual([]);
    for (const callId of calls.slice(0, 2))
      expect(await f.services.researchContinue(callId, true)).toMatchObject({
        status: "working",
      });
    expect(await f.services.researchContinue(calls[2]!, true)).toMatchObject({
      status: "done",
    });
  });
  it("counts matching accepted values on distinct canonical Purchases as new progress", async () => {
    const f = await admitted();
    const next = z
      .object({ work: z.object({ workRef: z.uuid() }) })
      .parse(await f.services.researchNext({}, crypto.randomUUID()));
    await f.services.researchMailRead(
      { workRef: next.work.workRef, messageRef: f.mail.id },
      crypto.randomUUID(),
    );
    const [original] = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.targetId, next.work.workRef));
    if (!original) throw new Error("Synthetic retained original missing");
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic continuation retailer",
    });
    const first = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "SYNTHETIC-FIRST",
      statedTotal: 24,
    });
    const second = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "SYNTHETIC-SECOND",
      statedTotal: 24,
    });
    const retain = (entityId: typeof first.id) =>
      withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, {
          runId: parseEntityId("run", f.started.runId),
          targetId: next.work.workRef,
          subject: { entityKind: "purchase", entityId },
          claims: [
            {
              evidenceId: original.id,
              fieldPath: "statedTotal",
              value: 24,
              support: {
                observation: "Total $24",
                reasoning:
                  "The retained original supports this exact Purchase total.",
              },
            },
          ],
        }),
      );
    await retain(first.id);
    await f.services.researchContinue(crypto.randomUUID());
    await f.services.researchContinue(crypto.randomUUID());
    await retain(second.id);
    expect(
      await f.services.researchContinue(crypto.randomUUID()),
    ).toMatchObject({
      status: "working",
      work: { workRef: next.work.workRef },
    });
  });
  it("bounds unchanged yielded work without counting replay or rereading identical evidence as progress", async () => {
    const f = await admitted(2);
    const current = z.object({
      status: z.literal("working"),
      work: z.object({ workRef: z.uuid() }),
    });
    const firstCall = crypto.randomUUID();
    const first = current.parse(await f.services.researchContinue(firstCall));
    expect(await f.services.researchContinue(firstCall)).toMatchObject(first);
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, first.work.workRef));
    if (!target?.workKey) throw new Error("Synthetic yielded task missing");
    const observe = () =>
      f.services.researchMailRead(
        { workRef: target.id, messageRef: target.workKey! },
        crypto.randomUUID(),
      );
    await observe();
    const changed = current.parse(
      await f.services.researchContinue(crypto.randomUUID()),
    );
    expect(changed.work.workRef).toBe(target.id);
    await observe();
    const unchanged = current.parse(
      await f.services.researchContinue(crypto.randomUUID()),
    );
    expect(unchanged.work.workRef).toBe(target.id);
    const lastCall = crypto.randomUUID();
    const next = current.parse(await f.services.researchContinue(lastCall));
    expect(next.work.workRef).not.toBe(target.id);
    expect(await f.services.researchContinue(lastCall)).toMatchObject(next);
    const [settled] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, target.id));
    expect(settled).toMatchObject({
      state: "unresolved",
      outcome: "temporarily_blocked",
    });
    expect(settled?.warning).toContain("ended without resolving");
    const attempts = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, f.started.runId),
          eq(runOperation.kind, "research_continue"),
        ),
      );
    expect(attempts).toHaveLength(4);
  });
  it("continues every selected mail after ambiguity and finishes with review accounting only after the last task", async () => {
    const f = await admitted(2);
    const targets = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, f.started.runId))
      .orderBy(runTarget.position);
    expect(targets).toHaveLength(2);
    const first = z
      .object({
        status: z.literal("working"),
        work: z.object({ workRef: z.uuid() }),
      })
      .parse(await f.services.researchNext({}, crypto.randomUUID()));
    expect(targets.map((target) => target.id)).toContain(first.work.workRef);
    const second = targets.find((target) => target.id !== first.work.workRef);
    if (!second) throw new Error("Synthetic second selected task missing");
    const resolveAmbiguous = async (workRef: string) => {
      const callId = crypto.randomUUID();
      const proposal = {
        workRef,
        status: "ambiguous" as const,
        identity: {
          evidenceIds: [],
          reasoning: "Two plausible order identities remain unresolved.",
        },
        detail: "Related purchase mail needs more identity evidence.",
      };
      await resolveImportResearch(
        ctx.db,
        { runId: f.started.runId, workRef, callId, proposal },
        {
          assess: async () => ({
            identityVerified: false,
            acceptedFacts: [],
            acceptedIdentifiers: [],
            acceptedImages: [],
            acceptedOrders: [],
            acceptedEmailLinks: [],
            rejected: [],
          }),
        },
      );
      return f.services.researchResolve(proposal, callId);
    };
    expect(await resolveAmbiguous(first.work.workRef)).toMatchObject({
      status: "working",
      work: { workRef: second.id },
    });
    const [running] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, parseEntityId("run", f.started.runId)));
    expect(running?.status).toBe("running");
    expect(running?.endedAt).toBeNull();
    expect(await resolveAmbiguous(second.id)).toMatchObject({
      status: "done",
      summary: { verified: 0, unresolved: 2 },
    });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, parseEntityId("run", f.started.runId)));
    expect(saved?.status).toBe("needs_review");
    expect(saved?.endedAt).toBeInstanceOf(Date);
    expect(
      await getDb(ctx.db)
        .select({ state: runTarget.state, outcome: runTarget.outcome })
        .from(runTarget)
        .where(eq(runTarget.runId, f.started.runId)),
    ).toEqual([
      { state: "unresolved", outcome: "ambiguous" },
      { state: "unresolved", outcome: "ambiguous" },
    ]);
  });

  it("replays a committed resolution through the host after its target settled", async () => {
    const f = await admitted();
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, f.started.runId));
    if (!target) throw new Error("Synthetic work missing");
    const callId = crypto.randomUUID();
    const proposal = {
      workRef: target.id,
      status: "no_source_found" as const,
      identity: {
        evidenceIds: [],
        reasoning: "No supported matching receipt was found.",
      },
      detail: "The bounded investigation did not establish a purchase.",
    };
    const result = await resolveImportResearch(
      ctx.db,
      { runId: f.started.runId, workRef: target.id, callId, proposal },
      {
        assess: async () => ({
          identityVerified: false,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedIdentifierClaims: [],
          acceptedImages: [],
          acceptedOrders: [],
          acceptedEmailLinks: [],
          rejected: [],
        }),
      },
    );
    const {
      purchaseIds: _purchaseIds,
      productIds: _productIds,
      eventIds: _eventIds,
      ...publicResult
    } = result;
    expect(await f.services.researchResolve(proposal, callId)).toMatchObject({
      status: "done",
      resolution: {
        ...publicResult,
        purchaseContext: { purchases: [], incomplete: false },
        productRefs: [],
      },
    });
  });
  it("retains another Run's mail only as context without stealing its write ownership", async () => {
    const f = await admitted();
    const prior = await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: f.party.id,
      purpose: "mail_import",
      trigger: "manual",
      status: "running",
      actorUserId: ctx.actor.userId,
      actorName: f.party.name,
      actorEmail: "synthetic-context@example.test",
      actorLedgerPartyShortcode: f.party.shortcode,
      actorLedgerPartyName: f.party.name,
      actorLedgerPartyKind: f.party.kind,
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: f.party.id,
        mailboxId: f.mail.mailboxId,
        messageId: "synthetic-other-run-message",
        sender: f.mail.sender,
        subject: "Related shipping context",
        receivedAt: f.mail.receivedAt,
        rawChecksum: "b".repeat(64),
        content: f.mail.content,
      })
      .returning();
    if (!mail) throw new Error("Synthetic context mail missing");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: f.party.id,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
      checksum: mail.rawChecksum,
      classification: "related",
      classificationVersion: "synthetic-v1",
      status: "researching",
      orderMailId: mail.id,
      runId: prior.id,
    });
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, f.started.runId));
    if (!target) throw new Error("Synthetic work missing");
    await f.services.researchMailRead(
      { workRef: target.id, messageRef: mail.id },
      crypto.randomUUID(),
    );
    const [evidence] = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.runId, f.started.runId));
    expect(evidence?.sourceMetadata).toMatchObject({
      contextOnly: true,
      orderMailId: mail.id,
    });
    const [message] = await getDb(ctx.db)
      .select()
      .from(mailboxMessage)
      .where(eq(mailboxMessage.orderMailId, mail.id));
    expect(message?.runId).toBe(prior.id);
  });
});
