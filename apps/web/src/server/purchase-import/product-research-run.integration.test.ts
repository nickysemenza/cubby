import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { userId } from "@cubby/schemas/identifiers";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { acceptedResearchFact } from "@cubby/schemas/research";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { account } from "~/server/db/auth.schema";
import {
  orderMail,
  importSourceClaim,
  importSourceOrder,
  entityExternalId,
  product,
  productCategory,
  run,
  runEvidence,
  runTarget,
  user,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { updateProduct } from "~/server/repo/product/crud";
import {
  createProductFixture,
  createImageFixture,
  insertEntityAttachments,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  issueExecutionAuthorization,
  revokeExecutionAuthorization,
  reserveExecutionAuthorization,
} from "~/server/runs/execution-authorization";
import {
  executionAuthorizationFromInput,
  executionRequestForRun,
} from "~/server/runs/execution-context";

import { recordAcceptedFactEvidence } from "./fact-verification";
import { startProductResearch } from "./product-research-run";
import { productResearchFixture } from "./product-research.fixtures";
import {
  readResearchCanonicalProjection,
  researchMemberPath,
} from "./research-projection";
import { researchServiceFor } from "./research-service";
import { controlRun } from "./run-service";

// Admission failures: duplicate/replayed/overlapping launches, foreign parent,
// unchanged failed attempts looping, changed retained evidence never revisited.
describe("cloud Product research admission", () => {
  const ctx = withTestDb();
  // Paid binding failures: missing/foreign originals or approvals, mailbox ambiguity,
  // invalid latest approvals reviving an older bucket, and retries switching authority.
  // Historical per-order checksums differ from raw mail: bind only a retained
  // original in the exact owner's mailbox, never a missing or foreign receipt.
  const authorityModes = [
    "approved",
    "missing",
    "foreign",
    "expired",
    "revoked",
    "ambiguous",
    "no_original",
    "foreign_original",
    "legacy",
    "inherited",
    "historical",
    "historical_missing",
    "historical_foreign",
  ] as const;
  const prepareAuthority = async (mode: (typeof authorityModes)[number]) => {
    const f = await productResearchFixture(ctx.db, ctx.actor, {
      legacy: mode === "legacy",
    });
    const mailboxId = "synthetic-research-mailbox";
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    if (mode === "ambiguous")
      await getDb(ctx.db).insert(account).values({
        id: crypto.randomUUID(),
        accountId: "synthetic-other-mailbox",
        providerId: "google",
        userId: ctx.actor.userId,
        updatedAt: new Date(),
      });
    if (f.association)
      await getDb(ctx.db)
        .update(importSourceClaim)
        .set({
          externalKey: mode.startsWith("historical")
            ? "gmail:synthetic-message:order:SYNTHETIC-101"
            : `gmail:${mailboxId}:synthetic-message`,
          checksum: mode.startsWith("historical")
            ? "b".repeat(64)
            : "a".repeat(64),
        })
        .where(eq(importSourceClaim.id, f.association.sourceClaimId));
    if (mode !== "no_original" && mode !== "historical_missing")
      await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: f.party.id,
          mailboxId:
            mode === "foreign_original" || mode === "historical_foreign"
              ? "synthetic-foreign-mailbox"
              : mailboxId,
          messageId: "synthetic-message",
          sender: "seller@example.test",
          subject: "Synthetic receipt",
          rawChecksum: "a".repeat(64),
          content: {
            snippet: null,
            bodyText: "Synthetic ordered device",
            bodyHtml: null,
          },
        });
    const otherUserId = userId.parse("synthetic-foreign-approval-user");
    const approvalActor =
      mode === "foreign" ? { ...ctx.actor, userId: otherUserId } : ctx.actor;
    let approvalMemberId = f.party.id;
    if (mode === "foreign") {
      await getDb(ctx.db).insert(user).values({
        id: otherUserId,
        name: "Synthetic foreign member",
        email: "foreign@example.test",
      });
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic foreign owner",
        kind: "member",
        userId: otherUserId,
      });
      approvalMemberId = party.id;
      await getDb(ctx.db).insert(account).values({
        id: crypto.randomUUID(),
        accountId: mailboxId,
        providerId: "google",
        userId: otherUserId,
        updatedAt: new Date(),
      });
    }
    const approval =
      mode === "missing"
        ? undefined
        : await issueExecutionAuthorization(
            ctx.db,
            approvalActor,
            executionAuthorizationInput.parse({
              kind: "execution_authorization",
              version: 1,
              owner: {
                userId: approvalActor.userId,
                ledgerPartyId: approvalMemberId,
              },
              scope:
                mode === "inherited"
                  ? {
                      kind: "pilot",
                      mailboxId,
                      discovery: "targeted",
                      candidateLimit: 10,
                      productLimit: 10,
                    }
                  : { kind: "backfill", mailboxId, discovery: "all_history" },
              meteredBudget: {
                period: "lifetime",
                limitMicroUSD: 10_000_000,
              },
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
    if (approval && mode === "inherited")
      await getDb(ctx.db)
        .update(run)
        .set({
          input: {
            kind: "product_research",
            instructionRevision: 1,
            products: [],
            executionAuthorization: approval,
          },
        })
        .where(eq(run.id, f.parent.id));
    const input = {
      ledgerPartyId: f.party.id,
      userId: ctx.actor.userId,
      productIds: [f.item.entityId],
      parentRunId: f.parent.id,
    };
    const queue = { send: async (_event: PurchaseAgentEvent) => {} };
    return { f, mailboxId, approval, input, queue };
  };
  it.each([
    "missing",
    "foreign",
    "ambiguous",
    "no_original",
    "foreign_original",
    "legacy",
    "historical_missing",
    "historical_foreign",
  ] as const)(
    "leaves unsupported retained-mail backfill unpaid: %s",
    async (mode) => {
      const { f, input, queue } = await prepareAuthority(mode);
      const [started] = await startProductResearch(ctx.db, input, queue);
      if (!started) throw new Error("Synthetic launch missing");
      const [saved] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, started.runId));
      expect(executionAuthorizationFromInput(saved?.input)).toBeUndefined();
      const [parent] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, f.parent.id));
      expect(executionAuthorizationFromInput(parent?.input)).toBeUndefined();
    },
  );
  it.each(["expired", "revoked"] as const)(
    "refuses invalid latest retained-mail backfill: %s",
    async (mode) => {
      const { approval, input, queue } = await prepareAuthority(mode);
      if (!approval) throw new Error("Synthetic approval missing");
      const [root] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, approval.runId));
      const snapshot = executionAuthorizationInput.parse(root?.input);
      // A valid older approval cannot be revived by rejecting the latest root.
      await issueExecutionAuthorization(ctx.db, ctx.actor, snapshot);
      await getDb(ctx.db)
        .update(run)
        .set({ createdAt: new Date(Date.now() + 1000) })
        .where(eq(run.id, approval.runId));
      if (mode === "expired")
        await getDb(ctx.db)
          .update(run)
          .set({ input: { ...snapshot, expiresAt: "2020-01-01T00:00:00Z" } })
          .where(eq(run.id, approval.runId));
      else await revokeExecutionAuthorization(ctx.db, ctx.actor, approval);
      await expect(startProductResearch(ctx.db, input, queue)).rejects.toThrow(
        mode,
      );
      expect(await getDb(ctx.db).select().from(runTarget)).toHaveLength(0);
    },
  );
  it.each(["approved", "inherited", "historical"] as const)(
    "keeps retained-mail approval and retry cap bucket stable: %s",
    async (mode) => {
      const { f, input, queue, approval, mailboxId } =
        await prepareAuthority(mode);
      const [parentBefore] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, f.parent.id));
      const [started] = await startProductResearch(ctx.db, input, queue);
      if (!started) throw new Error("Synthetic launch missing");
      const [saved] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, started.runId));
      expect(executionAuthorizationFromInput(saved?.input)).toEqual(approval);
      const [parentAfter] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, f.parent.id));
      expect(parentAfter).toEqual(parentBefore);
      const authority = await executionRequestForRun(ctx.db, started.runId);
      if (!authority) throw new Error("Synthetic execution authority missing");
      expect(
        await reserveExecutionAuthorization(ctx.db, {
          ...authority,
          physicalAttemptId: crypto.randomUUID(),
          reservationMicroUSD: 10_000_000,
        }),
      ).toEqual({ status: "reserved" });
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "needs_review",
          failureCode: "execution_limit",
          endedAt: new Date(),
        })
        .where(eq(run.id, started.runId));
      await getDb(ctx.db)
        .update(runTarget)
        .set({
          state: "unresolved",
          outcome: "researched_with_gaps",
          completedAt: new Date(),
        })
        .where(eq(runTarget.runId, started.runId));
      if (!saved) throw new Error("Synthetic saved launch missing");
      // A later allowance must not move this retry off its exhausted bucket.
      await issueExecutionAuthorization(
        ctx.db,
        ctx.actor,
        executionAuthorizationInput.parse({
          kind: "execution_authorization",
          version: 1,
          owner: { userId: ctx.actor.userId, ledgerPartyId: f.party.id },
          scope: { kind: "backfill", mailboxId, discovery: "all_history" },
          meteredBudget: { period: "lifetime", limitMicroUSD: 10_000_000 },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      const retry = await controlRun(ctx.db, ctx.actor, {
        runPublicId: saved.shortcode,
        action: "retry",
      });
      if (!("successorRunId" in retry) || !retry.successorRunId)
        throw new Error("Synthetic retry missing");
      const [successor] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, retry.successorRunId));
      expect(executionAuthorizationFromInput(successor?.input)).toEqual(
        approval,
      );
      const retryAuthority = await executionRequestForRun(
        ctx.db,
        retry.successorRunId,
      );
      if (!retryAuthority) throw new Error("Synthetic retry authority missing");
      expect(
        await reserveExecutionAuthorization(ctx.db, {
          ...retryAuthority,
          physicalAttemptId: crypto.randomUUID(),
          reservationMicroUSD: 1,
        }),
      ).toEqual({ status: "refused", reason: "budget_exhausted" });
      const [original] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, started.runId));
      expect(original?.failureCode).toBe("execution_limit");
    },
  );
  it("revisits a changed declared Ingredient link without looping on unchanged reference facts", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor);
    const [food] = await getDb(ctx.db)
      .select()
      .from(productCategory)
      .where(
        and(eq(productCategory.feature, "food"), notDeleted(productCategory)),
      )
      .limit(1);
    if (!food) throw new Error("Synthetic food root missing");
    await getDb(ctx.db)
      .update(product)
      .set({ categoryId: food.id })
      .where(eq(product.id, f.item.entityId));
    const ingredient = await insertWithShortcode(ctx.db, "ingredient", {
      name: "Example member classification",
    });
    const input = {
      ledgerPartyId: f.party.id,
      userId: ctx.actor.userId,
      productIds: [f.item.entityId],
    };
    const queue = { send: async (_event: PurchaseAgentEvent) => {} };
    const [first] = await startProductResearch(ctx.db, input, queue);
    if (!first) throw new Error("Synthetic first research missing");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "needs_review", endedAt: new Date() })
      .where(eq(run.id, first.runId));
    await getDb(ctx.db)
      .update(runTarget)
      .set({
        state: "unresolved",
        outcome: "researched_with_gaps",
        completedAt: new Date(),
      })
      .where(eq(runTarget.runId, first.runId));
    expect(await startProductResearch(ctx.db, input, queue)).toEqual([]);
    await updateProduct(
      ctx.db,
      f.item.entityId,
      { ingredientId: ingredient.id },
      ctx.actor,
    );
    const [fresh] = await startProductResearch(ctx.db, input, queue);
    expect(fresh).toBeDefined();
    if (!fresh) throw new Error("Changed classification was never admitted");
    expect(fresh.runId).not.toBe(first.runId);
    expect(
      await researchServiceFor(
        ctx.db,
        fromPartial<Env>({}),
        fresh.runId,
      ).researchNext({}, crypto.randomUUID()),
    ).toMatchObject({
      status: "working",
      work: {
        kind: "product",
        product: {
          ingredientId: ingredient.shortcode,
          categoryId: food.shortcode,
        },
      },
    });
    const [before] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, first.runId));
    expect(before).toMatchObject({
      state: "unresolved",
      outcome: "researched_with_gaps",
    });
  });
  it("recovers a failed producer handoff on the same durable Run generation", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor);
    const input = {
      ledgerPartyId: f.party.id,
      userId: ctx.actor.userId,
      productIds: [f.item.entityId],
    };
    const [failed] = await startProductResearch(ctx.db, input, {
      send: async () => {
        throw new Error("Synthetic producer unavailable");
      },
    });
    if (!failed) throw new Error("Synthetic dispatch admission missing");
    expect(failed.status).toBe("dispatch_failed");
    const events: PurchaseAgentEvent[] = [];
    const [recovered] = await startProductResearch(ctx.db, input, {
      send: async (event) => {
        events.push(event);
      },
    });
    expect(recovered).toMatchObject({
      runId: failed.runId,
      status: "running",
      created: false,
    });
    expect(await getDb(ctx.db).select().from(runTarget)).toHaveLength(1);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, failed.runId));
    expect(events).toMatchObject([
      { eventId: saved?.dispatchEventId, runId: failed.runId },
    ]);
  });
  it("keeps fully proved host fills closed for unchanged original context and revisits new original evidence", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor, {
      complete: true,
    });
    if (!f.association) throw new Error("Synthetic retained source missing");
    await getDb(ctx.db)
      .update(product)
      .set({ model: "" })
      .where(eq(product.id, f.item.entityId));
    const representative = await createImageFixture(
      ctx.db,
      "research-proved-catalog",
      {
        source: "catalog",
        sha256: "d".repeat(64),
        sourceAssetUrl: "https://images.example.test/q17-small.png",
      },
    );
    const [attachment] = await insertEntityAttachments(ctx.db, {
      entityId: f.item.entityId,
      imageId: representative.id,
      purpose: "item",
      sortOrder: 1,
    });
    if (!attachment) throw new Error("Synthetic catalog attachment missing");
    const input = {
      ledgerPartyId: f.party.id,
      userId: ctx.actor.userId,
      productIds: [f.item.entityId],
    };
    const events: PurchaseAgentEvent[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        events.push(event);
      },
    };
    const [first] = await startProductResearch(ctx.db, input, queue);
    if (!first) throw new Error("Synthetic initial research missing");
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, first.runId));
    const [identifier] = await getDb(ctx.db)
      .select()
      .from(entityExternalId)
      .where(eq(entityExternalId.entityId, f.item.entityId));
    const [current] = await getDb(ctx.db)
      .update(product)
      .set({ model: "Q-17" })
      .where(eq(product.id, f.item.entityId))
      .returning();
    if (!target || !identifier || !current)
      throw new Error("Synthetic current facts missing");
    const [evidence] = await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId: first.runId,
        targetId: target.id,
        kind: "web_page",
        checksum: "e".repeat(64),
        objectKey: "synthetic-research/q17-small",
        mediaType: "text/html",
        sourceMetadata: { url: "https://shop.example.test/q17-small" },
      })
      .returning();
    if (!evidence) throw new Error("Synthetic accepted observation missing");
    const support = {
      observation:
        "Example Works Q-17 small device, category Example devices, retailer SKU SMALL-17; the selected option image shows the small Q-17.",
      reasoning:
        "The small selected ordered variant identifies the maker, model, category, identifier, and representative image.",
      selectedVariant: {
        identity: "Q-17",
        attributes: { size: "small" },
        reasoning:
          "The selected small option matches the retained ordered item.",
      },
    };
    const facts = [
      { fieldPath: "manufacturer", value: current.manufacturer },
      { fieldPath: "model", value: current.model },
      { fieldPath: "categoryId", value: current.categoryId },
      {
        fieldPath: researchMemberPath("externalIds", identifier.id),
        value: {
          source: identifier.source,
          kind: identifier.kind,
          externalId: identifier.externalId,
        },
      },
      {
        fieldPath: researchMemberPath("images", attachment.id),
        value: {
          imageId: representative.shortcode,
          sourceAssetUrl: representative.sourceAssetUrl,
          contentHash: representative.sha256,
        },
      },
    ].map((fact) =>
      acceptedResearchFact.parse({ ...fact, evidenceId: evidence.id, support }),
    );
    await withTransaction(ctx.db, (tx) =>
      recordAcceptedFactEvidence(
        tx,
        { runId: first.runId, targetId: target.id, claims: facts },
        readResearchCanonicalProjection,
      ),
    );
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(run.id, first.runId));
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "completed", outcome: "verified", completedAt: new Date() })
      .where(eq(runTarget.id, target.id));
    expect(await startProductResearch(ctx.db, input, queue)).toEqual([]);
    // Field coverage can be complete while purchased-variant research still
    // has gaps. An explicit retry must admit fresh work without rewriting history.
    await getDb(ctx.db)
      .update(run)
      .set({ status: "needs_review" })
      .where(eq(run.id, first.runId));
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "unresolved", outcome: "partially_verified" })
      .where(eq(runTarget.id, target.id));
    const [predecessor] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, first.runId));
    if (!predecessor) throw new Error("Research predecessor missing");
    const retry = await controlRun(ctx.db, ctx.actor, {
      runPublicId: predecessor.shortcode,
      action: "retry",
    });
    expect(retry).toMatchObject({ created: true });
    if (!("successorRunId" in retry) || !retry.successorRunId)
      throw new Error("Explicit research retry missing");
    const [successor] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, retry.successorRunId));
    if (!successor) throw new Error("Research successor missing");
    expect(successor.predecessorRunId).toBe(first.runId);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.id, target.id)),
    ).toMatchObject([{ state: "unresolved", outcome: "partially_verified" }]);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(run.id, successor.id));
    await getDb(ctx.db)
      .update(importSourceClaim)
      .set({ checksum: "f".repeat(64) })
      .where(eq(importSourceClaim.id, f.association.sourceClaimId));
    await getDb(ctx.db)
      .update(importSourceOrder)
      .set({ checksum: "f".repeat(64) })
      .where(eq(importSourceOrder.id, f.association.id));
    const [fresh] = await startProductResearch(ctx.db, input, queue);
    expect(fresh?.runId).not.toBe(first.runId);
    expect(events).toHaveLength(2);
  });
  it("admits an explicitly selected catalog Product without inventing purchase context", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor);
    const telemetry = await insertWithShortcode(ctx.db, "run", {
      purpose: "ai_suggest",
      trigger: "manual",
      actorUserId: ctx.actor.userId,
      actorName: "Example research member",
      actorEmail: "research@example.test",
    });
    const selected = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Example catalog-only device" }),
      ctx.actor,
    );
    const events: PurchaseAgentEvent[] = [];
    const [started] = await startProductResearch(
      ctx.db,
      {
        ledgerPartyId: f.party.id,
        userId: ctx.actor.userId,
        productIds: [selected.entityId],
        cause: "member_request",
        parentRunId: telemetry.id,
      },
      {
        send: async (event) => {
          events.push(event);
        },
      },
    );
    expect(started).toBeDefined();
    if (!started) throw new Error("Selected Product admission missing");
    expect(await getDb(ctx.db).select().from(runTarget)).toMatchObject([
      { entityId: selected.entityId, state: "pending" },
    ]);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, started.runId));
    expect(saved).toMatchObject({
      cause: "member_request",
      parentRunId: telemetry.id,
      vendorAccountId: null,
    });
    expect(events).toHaveLength(1);
  });
  it("admits and dispatches an owned Product once without a Mac, preserving parent lineage", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor);
    const events: unknown[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        events.push(event);
      },
    };
    const input = {
      ledgerPartyId: f.party.id,
      userId: ctx.actor.userId,
      productIds: [f.item.entityId],
      parentRunId: f.parent.id,
    };
    const [first] = await startProductResearch(ctx.db, input, queue);
    if (!first) throw new Error("Product research admission missing");
    const second = await startProductResearch(ctx.db, input, queue);
    expect(second.map((result) => result.runId)).toEqual([first.runId]);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, first.runId));
    expect(saved).toMatchObject({
      purpose: "product_enrichment",
      vendorAccountId: null,
      parentRunId: f.parent.id,
      cause: "import_completed",
      attempt: 1,
      input: { kind: "product_research" },
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, first.runId)),
    ).toMatchObject([
      { entityKind: "product", entityId: f.item.entityId, state: "pending" },
    ]);
    expect(events).toHaveLength(1);
  });
  it("fences concurrent Product admissions into one active immutable task", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor);
    const events: unknown[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        events.push(event);
      },
    };
    const input = {
      ledgerPartyId: f.party.id,
      userId: ctx.actor.userId,
      productIds: [f.item.entityId],
    };
    const launches = await Promise.all([
      startProductResearch(ctx.db, input, queue),
      startProductResearch(ctx.db, input, queue),
    ]);
    const owners = launches.flat().map((result) => result.runId);
    expect(new Set(owners).size).toBe(1);
    expect(await getDb(ctx.db).select().from(runTarget)).toHaveLength(1);
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((event) => JSON.stringify(event))).size).toBe(1);
  });
  it("holds unchanged failed context and admits changed original evidence without reopening the old task", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor);
    const events: unknown[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        events.push(event);
      },
    };
    const input = {
      ledgerPartyId: f.party.id,
      userId: ctx.actor.userId,
      productIds: [f.item.entityId],
    };
    const [first] = await startProductResearch(ctx.db, input, queue);
    if (!first || !f.association)
      throw new Error("Synthetic admission missing");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(run.id, first.runId));
    await getDb(ctx.db)
      .update(runTarget)
      .set({
        state: "unresolved",
        outcome: "temporarily_blocked",
        completedAt: new Date(),
      })
      .where(eq(runTarget.runId, first.runId));
    expect(await startProductResearch(ctx.db, input, queue)).toEqual([]);
    await getDb(ctx.db)
      .update(importSourceOrder)
      .set({ checksum: "c".repeat(64) })
      .where(eq(importSourceOrder.id, f.association.id));
    await getDb(ctx.db)
      .update(importSourceClaim)
      .set({ checksum: "c".repeat(64) })
      .where(eq(importSourceClaim.id, f.association.sourceClaimId));
    const [fresh] = await startProductResearch(ctx.db, input, queue);
    expect(fresh?.runId).not.toBe(first.runId);
    expect(events).toHaveLength(2);
    const [old] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, first.runId));
    expect(old).toMatchObject({
      state: "unresolved",
      outcome: "temporarily_blocked",
    });
  });
  it("rejects a parent outside the owning member before admission or dispatch", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor);
    const otherUserId = userId.parse("synthetic-other-research-user");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Other research member",
      email: "other-research@example.test",
    });
    const foreign = await insertWithShortcode(ctx.db, "ledgerParty", {
      kind: "member",
      name: "Other research owner",
      userId: otherUserId,
    });
    await getDb(ctx.db)
      .update(run)
      .set({ ledgerPartyId: foreign.id })
      .where(eq(run.id, f.parent.id));
    const events: unknown[] = [];
    await expect(
      startProductResearch(
        ctx.db,
        {
          ledgerPartyId: f.party.id,
          userId: ctx.actor.userId,
          productIds: [f.item.entityId],
          parentRunId: f.parent.id,
        },
        {
          send: async (event: PurchaseAgentEvent) => {
            events.push(event);
          },
        },
      ),
    ).rejects.toThrow(/parent|member|own/);
    expect(await getDb(ctx.db).select().from(runTarget)).toEqual([]);
    expect(events).toEqual([]);
  });
});
