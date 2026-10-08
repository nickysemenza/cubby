import { extractedOrderCandidate } from "@cubby/schemas/purchase-import";
import { researchAssessment } from "@cubby/schemas/research-assessment";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { targetedImportStartInput } from "@cubby/schemas/run";
import { searchHitSchema } from "@cubby/schemas/search";
// Public search can return a reference the resolver rejects; selected identity
// can be absent from source assessment; a deleted selection can still write;
// UUID translation can leak into read-only validation or invent stock.
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AiChatRequest } from "~/server/ai/run-feature";
import * as structured from "~/server/ai/run-feature";
import { setCfEnv } from "~/server/cf-env";
import {
  expense,
  entityExternalId,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  inventoryEntry,
  mailboxMessage,
  orderMail,
  orderMailEvent,
  orderMailCandidateDecision,
  product,
  purchase,
  runFinding,
  runTarget,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { syncProductExternalIds } from "~/server/repo/product/update-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { refreshSearchDocuments } from "~/server/repo/search-document";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { productionBrowserEvidenceStorage } from "./browser-results";
import { retainResearchObservation } from "./research-observations";
import { startMailResearch } from "./research-run";
import { researchServiceFor } from "./research-service";
import { lockPartySettlement } from "./retained-settlement";
import { startTargetedImport } from "./targeted-run";

describe("research public existing-Product admission", () => {
  const ctx = withTestDb();
  afterEach(() => {
    vi.restoreAllMocks();
    setCfEnv(undefined);
  });

  async function fixture(multipleOrders = false) {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic reuse member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic instrument seller",
    });
    const selected = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic copper instrument",
        manufacturer: "Synthetic Instruments",
        model: "COPPER-XL",
        externalIds: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "B0SYNTHXL1",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );
    const sibling = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic blue instrument",
        model: "BLUE-SMALL",
      }),
      ctx.actor,
    );
    // Repo fixtures do not consume the asynchronous search-index queue.
    await refreshSearchDocuments(ctx.db, [
      { entityKind: "product", entityId: selected.entityId },
      { entityKind: "product", entityId: sibling.entityId },
    ]);
    const body = multipleOrders
      ? "Original order SYNTHETIC-REUSE-A: Synthetic copper instrument, COPPER-XL, ASIN B0SYNTHXL1, USD 24. Original order SYNTHETIC-REUSE-B: Synthetic blue instrument, BLUE-SMALL, USD 24. Neither delivered."
      : "Original order SYNTHETIC-REUSE: Synthetic copper instrument, COPPER-XL, ASIN B0SYNTHXL1. One item, USD 24. Not delivered.";
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        mailboxId: "synthetic-reuse-mailbox",
        messageId: "synthetic-reuse-message",
        sender: "orders@instruments.example.test",
        subject: "Original instrument receipt",
        receivedAt: new Date("2026-09-01T12:00:00Z"),
        rawChecksum: await sha256Hex(body),
        content: { snippet: null, bodyText: body, bodyHtml: null },
      })
      .returning();
    if (!mail) throw new Error("Synthetic original missing.");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: party.id,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
      checksum: mail.rawChecksum,
      classification: "related",
      classificationVersion: "synthetic-reuse-v1",
      status: "pending",
      orderMailId: mail.id,
    });
    const bytes = new Map<string, Uint8Array>();
    const storage = {
      put: async (key: string, data: Uint8Array) => {
        bytes.set(key, data);
      },
      get: async (key: string) => {
        const data = bytes.get(key);
        if (!data) throw new Error("Synthetic retained original missing.");
        return new TextDecoder().decode(data);
      },
    };
    vi.spyOn(productionBrowserEvidenceStorage, "get").mockImplementation(
      storage.get,
    );
    const env = fromPartial<Env>({
      R2_KEY_PREFIX: "synthetic/existing-product",
      PURCHASE_AGENT_QUEUE: { send: async () => {} },
    });
    setCfEnv(env);
    const ports = {
      observations: { storage, keyPrefix: env.R2_KEY_PREFIX },
      queue: { send: async () => {} },
    };
    const [started] = await startMailResearch(
      ctx.db,
      {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        mailboxId: mail.mailboxId,
        messageIds: [mail.id],
      },
      ports.queue,
    );
    if (!started) throw new Error("Synthetic mail admission missing.");
    const services = researchServiceFor(ctx.db, env, started.runId, ports);
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, started.runId));
    if (!target) throw new Error("Synthetic source task missing.");
    await services.researchNext({}, crypto.randomUUID());
    const observed = z
      .object({ evidenceId: z.uuid() })
      .parse(
        await services.researchMailRead(
          { workRef: target.id, messageRef: mail.id },
          crypto.randomUUID(),
        ),
      );
    const found = z
      .object({ results: z.array(searchHitSchema) })
      .parse(
        await services.researchFind(
          { workRef: target.id, query: "Synthetic copper instrument" },
          crypto.randomUUID(),
        ),
      );
    const hit = found.results.find(
      (row) => row.entityKind === "product" && row.id === selected.id,
    );
    expect(hit).toBeDefined();
    expect(hit).not.toHaveProperty("entityId");
    if (!hit) throw new Error("Actual search did not expose selected Product.");
    const candidate = {
      orderId: "SYNTHETIC-REUSE",
      orderedAt: "2026-09-01T12:00:00Z",
      merchant: seller.name,
      currency: "USD",
      printedGrandTotal: 24,
      lines: [
        {
          title: selected.name,
          amount: 24,
          quantity: 1,
          lineKind: "principal",
        },
      ],
      payments: [],
      allShipmentsDelivered: false,
    };
    const proposal = researchWorkResolve.parse({
      workRef: target.id,
      status: "verified",
      identity: {
        evidenceIds: [observed.evidenceId],
        reasoning:
          "Original variant and typed identifier match the selected Product.",
      },
      orders: [
        {
          vendorRef: seller.shortcode,
          sourceRefs: [observed.evidenceId],
          reasoning: "Original identifies COPPER-XL and ASIN B0SYNTHXL1.",
          candidate,
          productResolutions: [
            { kind: "existing", lineIndex: 0, productId: hit.id },
          ],
          defaultTrade: "other",
        },
      ],
      detail:
        "Reuse the supported existing Product without recording receipt of stock.",
    });
    return {
      party,
      seller,
      selected,
      sibling,
      mail,
      storage,
      env,
      ports,
      started,
      services,
      target,
      proposal,
      candidate,
    };
  }

  function supportedAssessment(
    duringAssessment?: () => Promise<void>,
    acceptedOrders = [0],
    captureRequest?: (request: AiChatRequest) => void,
  ) {
    return vi
      .spyOn(structured, "runStructuredFeature")
      .mockImplementation(async (_feature, request) => {
        captureRequest?.(request);
        const payload = request.messages
          .flatMap((message) =>
            Array.isArray(message.content)
              ? message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.content)
              : [message.content],
          )
          .join("\n");
        expect(payload).toContain("Original order SYNTHETIC-REUSE");
        expect(payload).toContain("B0SYNTHXL1");
        await duringAssessment?.();
        return researchAssessment.parse({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          acceptedOrders,
          acceptedEmailLinks: [],
          rejected: [],
        });
      });
  }

  async function anotherOriginal(
    f: Awaited<ReturnType<typeof fixture>>,
    proposal = f.proposal,
  ) {
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ...f.mail,
        id: crypto.randomUUID(),
        messageId: "synthetic-independent-confirmation",
      })
      .returning();
    if (!mail) throw new Error("Second retained confirmation missing.");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: f.party.id,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
      checksum: mail.rawChecksum,
      classification: "related",
      classificationVersion: "synthetic-reuse-v1",
      status: "pending",
      orderMailId: mail.id,
    });
    const [started] = await startMailResearch(
      ctx.db,
      {
        ledgerPartyId: f.party.id,
        userId: ctx.actor.userId,
        mailboxId: mail.mailboxId,
        messageIds: [mail.id],
      },
      f.ports.queue,
    );
    if (!started) throw new Error("Second confirmation Run missing.");
    const services = researchServiceFor(ctx.db, f.env, started.runId, f.ports);
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, started.runId));
    if (!target) throw new Error("Second confirmation task missing.");
    await services.researchNext({}, crypto.randomUUID());
    const read = z
      .object({ evidenceId: z.uuid() })
      .parse(
        await services.researchMailRead(
          { workRef: target.id, messageRef: mail.id },
          crypto.randomUUID(),
        ),
      );
    return {
      mail,
      services,
      target,
      proposal: researchWorkResolve.parse({
        ...proposal,
        workRef: target.id,
        identity: { ...proposal.identity, evidenceIds: [read.evidenceId] },
        orders: proposal.orders.map((order) => ({
          ...order,
          sourceRefs: [read.evidenceId],
        })),
      }),
    };
  }

  it("retains each supported fresh confirmation's original Product lines without repeating purchases, expenses, or stock", async () => {
    const f = await fixture(true);
    const found = z
      .object({ results: z.array(searchHitSchema) })
      .parse(
        await f.services.researchFind(
          { workRef: f.target.id, query: "Synthetic blue instrument" },
          crypto.randomUUID(),
        ),
      );
    const blue = found.results.find((row) => row.id === f.sibling.id);
    if (!blue)
      throw new Error("Original's second Product missing from actual search.");
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      orders: [
        {
          ...f.proposal.orders[0],
          candidate: { ...f.candidate, orderId: "SYNTHETIC-REUSE-A" },
        },
        {
          ...f.proposal.orders[0],
          candidate: {
            ...f.candidate,
            orderId: "SYNTHETIC-REUSE-B",
            lines: [
              {
                title: f.sibling.name,
                amount: 24,
                quantity: 1,
                lineKind: "principal",
              },
            ],
          },
          productResolutions: [
            { kind: "existing", lineIndex: 0, productId: blue.id },
          ],
        },
      ],
    });
    supportedAssessment(undefined, [0, 1]);
    await f.services.researchResolve(proposal, crypto.randomUUID());
    const beforeExpenses = await getDb(ctx.db).select().from(expense);
    const second = await anotherOriginal(f, proposal);
    await second.services.researchResolve(second.proposal, crypto.randomUUID());
    expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(expense)).toEqual(beforeExpenses);
    expect(beforeExpenses.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBe(
      48,
    );
    const originals = await getDb(ctx.db).select().from(importSourceOrder);
    expect(originals).toHaveLength(4);
    const bindings = await getDb(ctx.db)
      .select({
        binding: importSourceProduct,
        original: importSourceOrder,
        source: importSourceClaim,
      })
      .from(importSourceProduct)
      .innerJoin(
        importSourceOrder,
        eq(importSourceOrder.id, importSourceProduct.sourceOrderId),
      )
      .innerJoin(
        importSourceClaim,
        eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
      );
    expect(bindings).toHaveLength(4);
    for (const message of [f.mail, second.mail]) {
      const sourceBindings = bindings.filter(
        (row) =>
          row.source.externalKey ===
          `gmail:${message.mailboxId}:${message.messageId}`,
      );
      expect(sourceBindings).toHaveLength(2);
      expect(sourceBindings.map((row) => row.binding.productId).sort()).toEqual(
        [f.selected.entityId, f.sibling.entityId].sort(),
      );
      for (const row of sourceBindings) {
        expect(row.binding.lineIndex).toBe(0);
        expect(row.original.originalOrder?.checksum).toBe(message.rawChecksum);
        expect(
          row.original.originalOrder?.extraction.candidate?.lines[0]?.title,
        ).toBe(
          row.binding.productId === f.selected.entityId
            ? f.selected.name
            : f.sibling.name,
        );
      }
    }
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });

  it.each([
    "human dismissed",
    "unproven",
    "mismatched canonical Product",
  ] as const)(
    "adds no fresh original Product binding for %s work",
    async (reason) => {
      const f = await fixture();
      const assessment = supportedAssessment();
      await f.services.researchResolve(f.proposal, crypto.randomUUID());
      const beforeExpenses = await getDb(ctx.db).select().from(expense);
      const [existing] = await getDb(ctx.db).select().from(purchase);
      if (!existing) throw new Error("Canonical supported Purchase missing.");
      const second = await anotherOriginal(f);
      if (reason === "human dismissed") {
        const [event] = await getDb(ctx.db)
          .insert(orderMailEvent)
          .values({
            orderMailId: second.mail.id,
            sourceKey: "synthetic-preserved-dismissal",
            event: "placed",
            orderId: existing.orderId,
            payload: {},
          })
          .returning();
        if (!event) throw new Error("Human review event missing.");
        await getDb(ctx.db).insert(orderMailCandidateDecision).values({
          eventId: event.id,
          purchaseId: existing.id,
          decision: "dismissed",
          evidenceChecksum: second.mail.rawChecksum,
          decidedByUserId: ctx.actor.userId,
        });
      } else if (reason === "unproven") {
        assessment.mockImplementationOnce(async () =>
          researchAssessment.parse({
            identityVerified: true,
            acceptedFacts: [],
            acceptedIdentifiers: [],
            acceptedImages: [],
            acceptedOrders: [],
            acceptedEmailLinks: [],
            rejected: [
              {
                path: "orders.0",
                reason: "Original item resolution is not supported.",
              },
            ],
          }),
        );
      } else {
        second.proposal.orders[0]!.productResolutions = [
          { kind: "existing", lineIndex: 0, productId: f.sibling.id },
        ];
      }
      await second.services.researchResolve(
        second.proposal,
        crypto.randomUUID(),
      );
      expect(await getDb(ctx.db).select().from(expense)).toEqual(
        beforeExpenses,
      );
      expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(1);
      const bindings = await getDb(ctx.db)
        .select({
          source: importSourceClaim.externalKey,
          binding: importSourceProduct,
        })
        .from(importSourceProduct)
        .innerJoin(
          importSourceOrder,
          eq(importSourceOrder.id, importSourceProduct.sourceOrderId),
        )
        .innerJoin(
          importSourceClaim,
          eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
        );
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        source: `gmail:${f.mail.mailboxId}:${f.mail.messageId}`,
        binding: { productId: f.selected.entityId, lineIndex: 0 },
      });
      const expectedSourceCount =
        reason === "mismatched canonical Product" ? 2 : 1;
      expect(await getDb(ctx.db).select().from(importSourceClaim)).toHaveLength(
        expectedSourceCount,
      );
      expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
        expectedSourceCount,
      );
      const dismissed = (
        await getDb(ctx.db).select().from(orderMailCandidateDecision)
      )
        .filter((decision) => decision.decision === "dismissed")
        .map(({ purchaseId, evidenceChecksum }) => ({
          purchaseId,
          evidenceChecksum,
        }));
      expect(dismissed).toEqual(
        reason === "human dismissed"
          ? [
              {
                purchaseId: existing.id,
                evidenceChecksum: second.mail.rawChecksum,
              },
            ]
          : [],
      );
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
    },
  );

  it("serializes a concurrent canonical identifier insertion after the accepted identity snapshot commits", async () => {
    const f = await fixture();
    supportedAssessment();
    await f.services.researchResolve(f.proposal, crypto.randomUUID());
    const second = await anotherOriginal(f);
    const [existing] = await getDb(ctx.db).select().from(purchase);
    if (!existing) throw new Error("Supported canonical Purchase missing.");
    const beforeExpenses = await getDb(ctx.db).select().from(expense);
    let imported:
      | ReturnType<typeof second.services.researchResolve>
      | undefined;
    let changed: Promise<void> | undefined;
    try {
      await withTransaction(ctx.db, async (tx) => {
        await tx
          .select({ id: purchase.id })
          .from(purchase)
          .where(eq(purchase.id, existing.id))
          .for("update");
        imported = second.services.researchResolve(
          second.proposal,
          crypto.randomUUID(),
        );
        imported.catch(() => undefined);
        await expect
          .poll(
            async () => {
              const waiting = await getDb(ctx.db)
                .execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"Purchase"%'`);
              return z.object({ count: z.number() }).parse(waiting.rows[0])
                .count;
            },
            { timeout: 5_000, interval: 20 },
          )
          .toBe(1);
        changed = withTransaction(ctx.db, async (mutation) => {
          await syncProductExternalIds(mutation, f.selected.entityId, [
            {
              source: "amazon",
              kind: "asin",
              externalId: "B0SYNTHXL1",
              url: null,
              isPrimary: true,
            },
            {
              source: "amazon",
              kind: "asin",
              externalId: "B0SYNTHNEW",
              url: null,
              isPrimary: false,
            },
          ]);
        });
        changed.catch(() => undefined);
        await expect
          .poll(
            async () => {
              const waiting = await getDb(ctx.db)
                .execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"Product"%' AND query LIKE '%for update%'`);
              return z.object({ count: z.number() }).parse(waiting.rows[0])
                .count;
            },
            { timeout: 5_000, interval: 20 },
          )
          .toBe(1);
      });
    } finally {
      if (imported) await imported;
      if (changed) await changed;
    }
    expect(await getDb(ctx.db).select().from(expense)).toEqual(beforeExpenses);
    expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
      2,
    );
    expect(
      await getDb(ctx.db)
        .select({ externalId: entityExternalId.externalId })
        .from(entityExternalId)
        .where(
          and(
            eq(entityExternalId.entityId, f.selected.entityId),
            eq(entityExternalId.kind, "asin"),
          ),
        ),
    ).toContainEqual({ externalId: "B0SYNTHNEW" });
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });

  it("allows selected-source Product admission while import waits on an existing source family without holding its Product", async () => {
    const f = await fixture();
    supportedAssessment();
    await f.services.researchResolve(f.proposal, crypto.randomUUID());
    const second = await anotherOriginal(f);
    const [originalClaim] = await getDb(ctx.db)
      .select()
      .from(importSourceClaim);
    const [originalOrder] = await getDb(ctx.db)
      .select()
      .from(importSourceOrder);
    if (!originalClaim || !originalOrder)
      throw new Error("Accepted source family missing.");
    const [claim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ...originalClaim,
        id: crypto.randomUUID(),
        externalKey: `gmail:${second.mail.mailboxId}:${second.mail.messageId}`,
        firstRunId: second.target.runId,
        lastRunId: second.target.runId,
      })
      .returning();
    if (!claim) throw new Error("Second canonical source family missing.");
    const [association] = await getDb(ctx.db)
      .insert(importSourceOrder)
      .values({
        ...originalOrder,
        id: crypto.randomUUID(),
        sourceClaimId: claim.id,
      })
      .returning();
    if (!association) throw new Error("Second accepted source order missing.");
    await getDb(ctx.db).insert(importSourceProduct).values({
      sourceOrderId: association.id,
      lineIndex: 0,
      productId: f.selected.entityId,
    });
    const beforeExpenses = await getDb(ctx.db).select().from(expense);
    let imported:
      | ReturnType<typeof second.services.researchResolve>
      | undefined;
    let admitted: ReturnType<typeof startTargetedImport> | undefined;
    let admissionCompleted = false;
    let settledStatuses: string[] = [];
    try {
      await withTransaction(ctx.db, async (tx) => {
        await tx
          .select({ id: importSourceClaim.id })
          .from(importSourceClaim)
          .where(eq(importSourceClaim.id, claim.id))
          .for("share");
        imported = second.services.researchResolve(
          second.proposal,
          crypto.randomUUID(),
        );
        imported.catch(() => undefined);
        await expect
          .poll(
            async () => {
              const waiting = await getDb(ctx.db)
                .execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"ImportSourceClaim"%' AND query LIKE '%for update%'`);
              return z.object({ count: z.number() }).parse(waiting.rows[0])
                .count;
            },
            { timeout: 5_000, interval: 20 },
          )
          .toBe(1);
        admitted = startTargetedImport(
          ctx.db,
          f.party.id,
          targetedImportStartInput.parse({
            purpose: "product_enrichment",
            targets: [{ productId: f.selected.id, sourceId: association.id }],
          }),
        );
        admitted.then(
          () => {
            admissionCompleted = true;
          },
          () => undefined,
        );
        await expect
          .poll(() => admissionCompleted, { timeout: 5_000, interval: 20 })
          .toBe(true);
      });
    } finally {
      const pending = [imported, admitted].filter(
        (value) => value !== undefined,
      );
      settledStatuses = (await Promise.allSettled(pending)).map(
        (value) => value.status,
      );
    }
    expect(settledStatuses).toEqual(["fulfilled", "fulfilled"]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual(beforeExpenses);
    expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
      2,
    );
    expect(await getDb(ctx.db).select().from(importSourceProduct)).toHaveLength(
      2,
    );
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });

  it("reads the original, finds a public Product, and reuses its supported identity without duplicates or stock", async () => {
    const f = await fixture();
    let request: AiChatRequest | undefined;
    supportedAssessment(undefined, [0], (value) => {
      request = value;
    });
    const callId = crypto.randomUUID();
    await f.services.researchResolve(f.proposal, callId);
    if (!request) throw new Error("Source support was not assessed.");
    const text = request.messages[0]?.content;
    if (!Array.isArray(text) || text[0]?.type !== "text")
      throw new Error("Assessment context missing.");
    const payload = z
      .object({ context: z.json() })
      .parse(JSON.parse(text[0].content));
    const contextText = JSON.stringify(payload.context);
    expect(contextText).toContain(f.selected.id);
    expect(contextText).toContain("COPPER-XL");
    expect(contextText).toContain("B0SYNTHXL1");
    expect(contextText).not.toContain(f.sibling.id);
    expect(await getDb(ctx.db).select().from(product)).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(expense)).toMatchObject([
      { productId: f.selected.entityId, cost: 24 },
    ]);
    expect(
      await getDb(ctx.db).select().from(importSourceProduct),
    ).toMatchObject([{ productId: f.selected.entityId, lineIndex: 0 }]);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
    await f.services.researchResolve(f.proposal, callId);
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
      1,
    );
  });

  it("refuses a Product deleted after discovery before committing Purchase, expenses, or source bindings", async () => {
    const f = await fixture();
    supportedAssessment();
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, f.selected.entityId));
    await expect(
      f.services.researchResolve(f.proposal, crypto.randomUUID()),
    ).rejects.toThrow(/Product|product.*(?:missing|available|found)|deleted/u);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceProduct)).toEqual([]);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(runTarget)
          .where(eq(runTarget.id, f.target.id))
      )[0]?.state,
    ).toBe("pending");
  });

  it.each(["model", "typed identifier"] as const)(
    "refuses a selected Product whose %s changes while original support is assessed",
    async (changedField) => {
      const f = await fixture();
      let request: AiChatRequest | undefined;
      supportedAssessment(
        async () => {
          if (changedField === "model") {
            await getDb(ctx.db)
              .update(product)
              .set({ model: "COPPER-SMALL" })
              .where(eq(product.id, f.selected.entityId));
          } else {
            await getDb(ctx.db)
              .update(entityExternalId)
              .set({ externalId: "B0SYNTHSM1" })
              .where(
                and(
                  eq(entityExternalId.entityId, f.selected.entityId),
                  eq(entityExternalId.kind, "asin"),
                ),
              );
          }
        },
        [0],
        (value) => {
          request = value;
        },
      );
      await expect(
        f.services.researchResolve(f.proposal, crypto.randomUUID()),
      ).rejects.toThrow(
        /Product.*(?:changed|identity|snapshot)|identity.*changed/u,
      );
      const part = request?.messages[0]?.content;
      if (!Array.isArray(part) || part[0]?.type !== "text")
        throw new Error("Original assessment request missing.");
      const assessed = z
        .object({ context: z.json() })
        .parse(JSON.parse(part[0].content));
      expect(JSON.stringify(assessed.context)).toContain("COPPER-XL");
      expect(JSON.stringify(assessed.context)).toContain("B0SYNTHXL1");
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(product)
            .where(eq(product.id, f.selected.entityId))
        )[0]?.model,
      ).toBe(changedField === "model" ? "COPPER-SMALL" : "COPPER-XL");
      expect(
        await getDb(ctx.db)
          .select({ externalId: entityExternalId.externalId })
          .from(entityExternalId)
          .where(
            and(
              eq(entityExternalId.entityId, f.selected.entityId),
              eq(entityExternalId.kind, "asin"),
            ),
          ),
      ).toEqual([
        {
          externalId:
            changedField === "typed identifier" ? "B0SYNTHSM1" : "B0SYNTHXL1",
        },
      ]);
      expect(await getDb(ctx.db).select().from(purchase)).toEqual([]);
      expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
      expect(await getDb(ctx.db).select().from(importSourceOrder)).toEqual([]);
      expect(await getDb(ctx.db).select().from(importSourceProduct)).toEqual(
        [],
      );
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(runTarget)
            .where(eq(runTarget.id, f.target.id))
        )[0]?.state,
      ).toBe("pending");
    },
  );

  it("serializes same-member two-source imports with opposite Product order without a database deadlock", async () => {
    const f = await fixture(true);
    const [otherMail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ...f.mail,
        id: crypto.randomUUID(),
        messageId: "synthetic-reuse-confirmation",
      })
      .returning();
    if (!otherMail) throw new Error("Second original missing.");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: f.party.id,
      mailboxId: otherMail.mailboxId,
      messageId: otherMail.messageId,
      checksum: otherMail.rawChecksum,
      classification: "related",
      classificationVersion: "synthetic-reuse-v1",
      status: "pending",
      orderMailId: otherMail.id,
    });
    const [otherRun] = await startMailResearch(
      ctx.db,
      {
        ledgerPartyId: f.party.id,
        userId: ctx.actor.userId,
        mailboxId: otherMail.mailboxId,
        messageIds: [otherMail.id],
      },
      f.ports.queue,
    );
    if (!otherRun) throw new Error("Second Run missing.");
    const other = researchServiceFor(ctx.db, f.env, otherRun.runId, f.ports);
    const [otherTarget] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, otherRun.runId));
    if (!otherTarget) throw new Error("Second source work missing.");
    await other.researchNext({}, crypto.randomUUID());
    const read = z
      .object({ evidenceId: z.uuid() })
      .parse(
        await other.researchMailRead(
          { workRef: otherTarget.id, messageRef: otherMail.id },
          crypto.randomUUID(),
        ),
      );
    const found = z
      .object({ results: z.array(searchHitSchema) })
      .parse(
        await other.researchFind(
          { workRef: otherTarget.id, query: "Synthetic blue instrument" },
          crypto.randomUUID(),
        ),
      );
    const blue = found.results.find((row) => row.id === f.sibling.id);
    if (!blue)
      throw new Error("Second public Product missing from actual search.");
    const copperOrder = {
      ...f.proposal.orders[0],
      candidate: { ...f.candidate, orderId: "SYNTHETIC-REUSE-A" },
    };
    const blueOrder = {
      ...copperOrder,
      candidate: {
        ...f.candidate,
        orderId: "SYNTHETIC-REUSE-B",
        lines: [
          {
            title: f.sibling.name,
            amount: 24,
            quantity: 1,
            lineKind: "principal",
          },
        ],
      },
      productResolutions: [
        { kind: "existing", lineIndex: 0, productId: blue.id },
      ],
    };
    const firstProposal = researchWorkResolve.parse({
      ...f.proposal,
      orders: [copperOrder, blueOrder],
    });
    const otherProposal = researchWorkResolve.parse({
      ...f.proposal,
      workRef: otherTarget.id,
      identity: { ...f.proposal.identity, evidenceIds: [read.evidenceId] },
      orders: [blueOrder, copperOrder].map((order) => ({
        ...order,
        sourceRefs: [read.evidenceId],
      })),
    });
    supportedAssessment(undefined, [0, 1]);
    let resolutions:
      | Promise<
          PromiseSettledResult<
            Awaited<ReturnType<typeof f.services.researchResolve>>
          >[]
        >
      | undefined;
    let settledStatuses: string[] = [];
    try {
      await withTransaction(ctx.db, async (tx) => {
        await lockPartySettlement(tx, f.party.id);
        resolutions = Promise.allSettled([
          f.services.researchResolve(firstProposal, crypto.randomUUID()),
          other.researchResolve(otherProposal, crypto.randomUUID()),
        ]);
        await expect
          .poll(
            async () => {
              const result = await getDb(ctx.db)
                .execute(sql`SELECT count(*)::int AS count FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND objid::bigint = (hashtext(${`purchase-settlement:${f.party.id}`})::bigint & 4294967295)`);
              return z.object({ count: z.number() }).parse(result.rows[0])
                .count;
            },
            { timeout: 5_000, interval: 20 },
          )
          .toBe(2);
      });
    } finally {
      if (resolutions) {
        const result = await resolutions;
        settledStatuses = result.map((value) => value.status);
      }
    }
    expect(settledStatuses).toEqual(["fulfilled", "fulfilled"]);
    expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
      4,
    );
    expect(await getDb(ctx.db).select().from(importSourceProduct)).toHaveLength(
      4,
    );
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });

  it("keeps the searched public Product operand in Purchase validation and writes no financial or stock changes", async () => {
    const f = await fixture();
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.seller.id,
      orderId: null,
      statedTotal: 24,
    });
    const line = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: order.id,
      productId: f.selected.entityId,
      name: f.selected.name,
      cost: 20,
      productQuantity: 1,
      costType: "materials",
      trade: "other",
      date: "2026-09-01",
      lineKind: "principal",
    });
    const admitted = await startTargetedImport(
      ctx.db,
      f.party.id,
      targetedImportStartInput.parse({
        purpose: "purchase_validation",
        purchaseId: order.shortcode,
        sourceId: null,
      }),
    );
    const code = admitted.runs[0]?.run?.id;
    if (!code) throw new Error("Synthetic validation admission missing.");
    const runId = await resolveOrThrow(ctx.db, "run", code);
    const services = researchServiceFor(ctx.db, f.env, runId, f.ports);
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, runId));
    if (!target) throw new Error("Validation task missing.");
    await services.researchNext({}, crypto.randomUUID());
    const original = await retainResearchObservation(
      ctx.db,
      {
        runId,
        workRef: target.id,
        callId: crypto.randomUUID(),
        kind: "web_page",
        sourceMetadata: { sourceURL: "https://receipt.example.test/original" },
        content: f.mail.content?.bodyText ?? "",
      },
      f.ports.observations,
    );
    const found = z
      .object({ results: z.array(searchHitSchema) })
      .parse(
        await services.researchFind(
          { workRef: target.id, query: "Synthetic copper instrument" },
          crypto.randomUUID(),
        ),
      );
    const hit = found.results.find((row) => row.id === f.selected.id);
    if (!hit) throw new Error("Validation search did not expose Product.");
    supportedAssessment();
    const resolutionCallId = crypto.randomUUID();
    const result = await services.researchResolve(
      researchWorkResolve.parse({
        ...f.proposal,
        workRef: target.id,
        identity: {
          ...f.proposal.identity,
          evidenceIds: [original.evidenceId],
        },
        orders: [
          {
            ...f.proposal.orders[0],
            purchaseRef: order.shortcode,
            sourceRefs: [original.evidenceId],
            candidate: extractedOrderCandidate.parse({
              ...f.candidate,
              orderId: null,
            }),
            productResolutions: [
              { kind: "existing", lineIndex: 0, productId: hit.id },
            ],
          },
        ],
      }),
      resolutionCallId,
    );
    expect(result).toMatchObject({
      resolution: {
        status: "researched_with_gaps",
        proposedOrders: [
          {
            purchaseRef: order.shortcode,
            productResolutions: [
              { kind: "existing", lineIndex: 0, productId: hit.id },
            ],
          },
        ],
      },
    });
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([order]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([line]);
    expect(await getDb(ctx.db).select().from(product)).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toEqual([]);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
    const findings = await getDb(ctx.db).select().from(runFinding);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      runId,
      ledgerPartyId: f.party.id,
      entityKind: "purchase",
      entityId: order.id,
      status: "open",
      autoApplied: false,
      proposedFix: {
        kind: "validation_corrections",
        purchaseId: order.id,
        targetId: target.id,
        resolutionOperationId: resolutionCallId,
      },
    });
  });
});
