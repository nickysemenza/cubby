import { type ProductId, productShortcode } from "@cubby/schemas/identifiers";
import type {
  BrowserBridgeRequest,
  BrowserBridgeResult,
  BrowserStructuredProducts,
} from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityExternalId,
  image,
  ledgerParty,
  product,
  productMatchCandidate,
  run as runTable,
  runEvidence,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { ensureExternalSources } from "~/server/repo/entity-external-ids";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { CAPTURE_INTERIM_NOTE } from "./capture-interim-note";
import {
  commitProductEnrichment,
  skipProductEnrichment,
} from "./import-orders";
import { productEnrichmentTarget } from "./product-enrichment-target";
import {
  claimNextImportWork,
  controlRun,
  finishRun,
  importBrowserOrderEvidence,
  issueBrowserCommand,
  startTargetedRun,
  stopRunForReview,
} from "./run-service";

const single: BrowserStructuredProducts = {
  products: [
    {
      skus: ["FW-TEE-BLK-M"],
      mpns: ["TEE-100"],
      gtins: ["036000291452"],
      productIds: [],
    },
  ],
  variantGroup: false,
};

describe("product enrichment structured identifier proof", () => {
  const ctx = withTestDb();

  async function fixture(
    structured: BrowserStructuredProducts | null = single,
    pageOverrides: { sourceURL?: string } = {},
  ) {
    const [existingParty] = await getDb(ctx.db)
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(eq(ledgerParty.userId, ctx.actor.userId));
    const party =
      existingParty ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Enrichment proof member",
        kind: "member",
        userId: ctx.actor.userId,
      }));
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `ForgeWear ${crypto.randomUUID()}`,
      website: "https://www.forgewear.example.test",
      browserDomains: ["forgewear.example.test"],
    });
    const target = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: `ForgeWear tee, black, M ${crypto.randomUUID()}`,
      }),
      ctx.actor,
    );
    const live = await productEnrichmentTarget(getDb(ctx.db), target.entityId);
    if (!live) throw new Error("Target product missing");
    const started = await startTargetedRun(ctx.db, {
      ledgerPartyId: party.id,
      purpose: "product_enrichment",
      vendorId: vendor.id,
      trigger: "manual",
      targets: [
        {
          kind: "product",
          productId: target.entityId,
          targetFingerprint: live.fingerprint,
        },
      ],
    });
    if (!started.created) throw new Error("Expected enrichment admission");
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "running" })
      .where(eq(runTable.id, started.run.id));
    const [ref] = await getDb(ctx.db)
      .select({ id: runTarget.id })
      .from(runTarget)
      .where(eq(runTarget.runId, started.run.id));
    if (!ref) throw new Error("Run target missing");
    // The server persists null for a capture from a Mac client that predates
    // structured product data.
    const sourceMetadata = {
      canonicalUrl: null,
      requestedAmazonAsin: null,
      servedAmazonAsin: null,
      variantMarkers: [],
      images: [],
      sourceURL:
        pageOverrides.sourceURL ??
        "https://www.forgewear.example.test/p/tee-black-m",
      structuredProducts: structured,
    };
    const [evidence] = await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId: started.run.id,
        targetId: ref.id,
        kind: "browser_capture",
        objectKey: `test/${crypto.randomUUID()}`,
        checksum: "a".repeat(64),
        mediaType: "application/pdf",
        sourceMetadata,
      })
      .returning({ id: runEvidence.id });
    if (!evidence) throw new Error("Evidence missing");
    const targetCode = await shortcodeOf(target.entityId);
    const commit = (
      identifiers: {
        source: string;
        kind: "retailer_sku" | "gtin_14" | "catalog_number";
        externalId: string;
      }[],
      operationId = `op-${crypto.randomUUID()}`,
    ) =>
      commitProductEnrichment(
        ctx.db,
        {
          _runExecution: { runId: started.run.id, operationId },
          productId: targetCode,
          targetFingerprint: live.fingerprint,
          changes: {
            identifiers: identifiers.map((identifier) => ({
              ...identifier,
              evidenceId: evidence.id,
            })),
          },
        },
        ctx.actor,
      );
    const commitImage = () =>
      commitProductEnrichment(
        ctx.db,
        {
          _runExecution: {
            runId: started.run.id,
            operationId: `op-${crypto.randomUUID()}`,
          },
          productId: targetCode,
          targetFingerprint: live.fingerprint,
          changes: {
            image: {
              evidenceId: evidence.id,
              url: "https://cdn.forgewear.example.test/tee.jpg",
              naturalWidth: 800,
              naturalHeight: 800,
            },
          },
        },
        ctx.actor,
      );
    return {
      target: { id: target.entityId },
      commit,
      commitImage,
      runId: started.run.id,
      targetCode,
      fingerprint: live.fingerprint,
      evidenceId: evidence.id,
    };
  }

  async function shortcodeOf(productId: ProductId) {
    const [row] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, productId));
    if (!row) throw new Error("Product fixture was not created");
    return productShortcode.parse(row.shortcode);
  }

  const identifiersOf = async (productId: ProductId) =>
    (
      await getDb(ctx.db)
        .select({
          source: entityExternalId.source,
          kind: entityExternalId.kind,
          externalId: entityExternalId.externalId,
        })
        .from(entityExternalId)
        .where(eq(entityExternalId.entityId, productId))
    ).sort((a, b) => a.kind.localeCompare(b.kind));

  it("learns a retailer SKU and a GTIN proven by a single-Product vendor page", async () => {
    const { target, commit } = await fixture();
    const result = await commit([
      { source: "forgewear", kind: "retailer_sku", externalId: "fw-tee-blk-m" },
      { source: "gtin", kind: "gtin_14", externalId: "036000291452" },
    ]);
    expect(result.changedFields).toEqual(["identifiers"]);
    expect(result.skippedIdentifiers).toEqual([]);
    expect(await identifiersOf(target.id)).toEqual([
      { source: "gtin", kind: "gtin_14", externalId: "00036000291452" },
      { source: "forgewear", kind: "retailer_sku", externalId: "FW-TEE-BLK-M" },
    ]);
  });

  // A finished run showed every enriched target still "awaiting the
  // purpose-specific comparison": the capture's interim note outlived the
  // commit, and the Runs list renders a target's warning as one.
  it("clears the capture's interim note when the target is enriched", async () => {
    const { runId, commit } = await fixture();
    await getDb(ctx.db)
      .update(runTarget)
      .set({
        state: "prepared",
        warning: CAPTURE_INTERIM_NOTE,
      })
      .where(eq(runTarget.runId, runId));
    await commit([
      { source: "forgewear", kind: "retailer_sku", externalId: "fw-tee-blk-m" },
    ]);
    expect(
      await getDb(ctx.db)
        .select({
          state: runTarget.state,
          outcome: runTarget.outcome,
          warning: runTarget.warning,
        })
        .from(runTarget)
        .where(eq(runTarget.runId, runId)),
    ).toEqual([{ state: "completed", outcome: "enriched", warning: null }]);
  });

  // A run stopped for review left its unfinished targets "awaiting the
  // commit"; they now say why the run stopped.
  it("replaces the capture's interim note with the stop reason", async () => {
    const { runId } = await fixture();
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "prepared", warning: CAPTURE_INTERIM_NOTE })
      .where(eq(runTarget.runId, runId));
    await stopRunForReview(ctx.db, {
      runId,
      operationId: "stop-for-review",
      kind: "other",
      summary: "The vendor page asks for a sign-in.",
    });
    expect(
      await getDb(ctx.db)
        .select({ state: runTarget.state, warning: runTarget.warning })
        .from(runTarget)
        .where(eq(runTarget.runId, runId)),
    ).toEqual([
      { state: "unresolved", warning: "The vendor page asks for a sign-in." },
    ]);
  });

  // Only the capture's own interim note is cleared; any other note on the
  // target (a reason someone wrote) survives the commit.
  it("keeps a target's other note when the target is enriched", async () => {
    const { runId, commit } = await fixture();
    await getDb(ctx.db)
      .update(runTarget)
      .set({ warning: "Size printed on the packet differs from the order." })
      .where(eq(runTarget.runId, runId));
    await commit([
      { source: "forgewear", kind: "retailer_sku", externalId: "fw-tee-blk-m" },
    ]);
    expect(
      await getDb(ctx.db)
        .select({ warning: runTarget.warning })
        .from(runTarget)
        .where(eq(runTarget.runId, runId)),
    ).toEqual([
      { warning: "Size printed on the packet differs from the order." },
    ]);
  });

  it("refuses an identifier the page does not show (a sibling variant) without partial writes", async () => {
    const { target, commit } = await fixture();
    await expect(
      commit([
        {
          source: "forgewear",
          kind: "retailer_sku",
          externalId: "FW-TEE-BLK-M",
        },
        {
          source: "forgewear",
          kind: "retailer_sku",
          externalId: "FW-TEE-BLK-L",
        },
      ]),
    ).rejects.toThrow("was not proven");
    expect(await identifiersOf(target.id)).toEqual([]);
  });

  it("refuses a ProductGroup page and an old capture with no structured data", async () => {
    const group = await fixture({ ...single, variantGroup: true });
    await expect(
      group.commit([
        {
          source: "forgewear",
          kind: "retailer_sku",
          externalId: "FW-TEE-BLK-M",
        },
      ]),
    ).rejects.toThrow("was not proven");
    const legacy = await fixture(null);
    await expect(
      legacy.commit([
        {
          source: "forgewear",
          kind: "retailer_sku",
          externalId: "FW-TEE-BLK-M",
        },
      ]),
    ).rejects.toThrow("was not proven");
  });

  it("refuses a page served from outside the vendor domains", async () => {
    const { commit } = await fixture(single, {
      sourceURL: "https://elsewhere.example.test/p/tee-black-m",
    });
    await expect(
      commit([
        {
          source: "forgewear",
          kind: "retailer_sku",
          externalId: "FW-TEE-BLK-M",
        },
      ]),
    ).rejects.toThrow("was not proven");
  });

  it("skips a proven identifier owned by another Product, proposes the pair, and still commits the rest", async () => {
    const { target, commit } = await fixture();
    const owner = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "ForgeWear tee, black, M (older record)" }),
      ctx.actor,
    );
    await ensureExternalSources(ctx.db, ["forgewear"]);
    await getDb(ctx.db).insert(entityExternalId).values({
      entityId: owner.entityId,
      entityKind: "product",
      source: "forgewear",
      kind: "retailer_sku",
      externalId: "FW-TEE-BLK-M",
      isPrimary: true,
    });
    const result = await commit([
      { source: "forgewear", kind: "retailer_sku", externalId: "FW-TEE-BLK-M" },
      { source: "gtin", kind: "gtin_14", externalId: "036000291452" },
    ]);
    expect(result.changedFields).toEqual(["identifiers"]);
    expect(result.skippedIdentifiers).toEqual([
      {
        source: "forgewear",
        kind: "retailer_sku",
        externalId: "FW-TEE-BLK-M",
        ownerProductId: await shortcodeOf(owner.entityId),
      },
    ]);
    expect(await identifiersOf(target.id)).toEqual([
      { source: "gtin", kind: "gtin_14", externalId: "00036000291452" },
    ]);
    expect(await identifiersOf(owner.entityId)).toHaveLength(1);
    const pairs = await getDb(ctx.db)
      .select({ state: productMatchCandidate.state })
      .from(productMatchCandidate)
      .where(
        and(
          eq(productMatchCandidate.source, "agent"),
          eq(productMatchCandidate.state, "open"),
        ),
      );
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const [stillOwner] = await getDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .where(eq(product.id, owner.entityId));
    expect(stillOwner).toBeDefined();
  });

  it("verifies no catalog image when the Product has no identifier the page proves", async () => {
    const { commitImage } = await fixture();
    await expect(commitImage()).rejects.toThrow("was not verified");
  });

  // A target closed by product_enrichment.skip is settled. A late commit,
  // from a model that kept going or a retried tool call, must neither write
  // the Product nor learn an identifier, and must refuse before importing an
  // image.
  it("refuses a commit for a skipped target and writes nothing", async () => {
    const { target, runId, targetCode, fingerprint, evidenceId, commitImage } =
      await fixture();
    await skipProductEnrichment(
      ctx.db,
      {
        _runExecution: { runId, operationId: "skip-before-commit" },
        productId: targetCode,
        reason: "No exact source page shows this variant.",
      },
      ctx.actor,
    );
    const imagesBefore = await getDb(ctx.db)
      .select({ id: image.id })
      .from(image);
    await expect(
      commitProductEnrichment(
        ctx.db,
        {
          _runExecution: { runId, operationId: "commit-after-skip" },
          productId: targetCode,
          targetFingerprint: fingerprint,
          changes: {
            identifiers: [
              {
                evidenceId,
                source: "forgewear",
                kind: "retailer_sku",
                externalId: "FW-TEE-BLK-M",
              },
            ],
          },
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/is skipped, not an open target/u);
    await expect(commitImage()).rejects.toThrow(
      /is skipped, not an open target/u,
    );
    expect(await identifiersOf(target.id)).toEqual([]);
    expect(await getDb(ctx.db).select({ id: image.id }).from(image)).toEqual(
      imagesBefore,
    );
    const [closed] = await getDb(ctx.db)
      .select({ state: runTarget.state, warning: runTarget.warning })
      .from(runTarget)
      .where(eq(runTarget.runId, runId));
    expect(closed).toEqual({
      state: "skipped",
      warning: "No exact source page shows this variant.",
    });
  });

  it("still replays a commit that succeeded once its target is completed", async () => {
    const { commit } = await fixture();
    const identifiers = [
      {
        source: "forgewear",
        kind: "retailer_sku" as const,
        externalId: "FW-TEE-BLK-M",
      },
    ];
    const first = await commit(identifiers, "op-completed-replay");
    expect(await commit(identifiers, "op-completed-replay")).toEqual(first);
  });

  it("replays the same operation id without re-running and rejects changed input", async () => {
    const { commit } = await fixture();
    const first = await commit(
      [
        {
          source: "forgewear",
          kind: "retailer_sku",
          externalId: "FW-TEE-BLK-M",
        },
      ],
      "op-replay",
    );
    const again = await commit(
      [
        {
          source: "forgewear",
          kind: "retailer_sku",
          externalId: "FW-TEE-BLK-M",
        },
      ],
      "op-replay",
    );
    expect(again).toEqual(first);
    await expect(
      commit(
        [{ source: "gtin", kind: "gtin_14", externalId: "036000291452" }],
        "op-replay",
      ),
    ).rejects.toThrow("replayed with different input");
  });
});

// One run works several Products in claim order. Failure modes: a Product
// with no exact source holds the run forever (nothing moves its target out
// of the worklist); a capture is filed under a different target than the
// one claimed, so the claimed Product's commit is refused; targets inserted
// together tie on createdAt and claim and capture pick different ones.
describe("product enrichment worklist", () => {
  const ctx = withTestDb();
  const issued: BrowserBridgeRequest[] = [];
  const results = new Map<string, BrowserBridgeResult>();
  const broker = {
    enqueue: async (command: BrowserBridgeRequest) => {
      issued.push(command);
    },
    result: async (commandId: string) => results.get(commandId) ?? null,
    cancel: async () => undefined,
    connected: async () => true,
    pendingCommands: async () => [],
    notifyRunCompleted: async () => undefined,
    requestAuthentication: async () => undefined,
  };
  const namespace = { getByName: () => broker };

  /** One running enrichment run over two Products inserted together. */
  async function worklist() {
    const [existingParty] = await getDb(ctx.db)
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(eq(ledgerParty.userId, ctx.actor.userId));
    const party =
      existingParty ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Enrichment worklist member",
        kind: "member",
        userId: ctx.actor.userId,
      }));
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Example Seed Shop ${crypto.randomUUID()}`,
      website: "https://seed.example.test",
      browserDomains: ["seed.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic seed account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
      status: "active",
      browserSyncEnabled: true,
    });
    const products = await Promise.all(
      ["Synthetic basil packet", "Synthetic dill packet"].map((name) =>
        createProductFixture(ctx.db, makeProductInput({ name }), ctx.actor),
      ),
    );
    const started = await startTargetedRun(ctx.db, {
      ledgerPartyId: party.id,
      purpose: "product_enrichment",
      vendorId: vendor.id,
      vendorAccountId: account.id,
      trigger: "discovery",
      targets: await Promise.all(
        products.map(async (row) => ({
          kind: "product" as const,
          productId: row.entityId,
          sourceExternalKey: "https://seed.example.test/",
          targetFingerprint: (await productEnrichmentTarget(
            getDb(ctx.db),
            row.entityId,
          ))!.fingerprint,
        })),
      ),
    });
    if (!started.created) throw new Error("Expected enrichment admission");
    const runId = started.run.id;
    const claim = async () => {
      const claimed = await claimNextImportWork(ctx.db, namespace, runId);
      if (claimed.kind !== "product_enrichment" || !("targetId" in claimed))
        throw new Error(`Expected enrichment work, got ${claimed.kind}`);
      return claimed;
    };
    const capture = async (operationId: string) => {
      await issueBrowserCommand(ctx.db, namespace, {
        runId,
        operationId,
        operation: {
          type: "capture",
          allowedHosts: ["seed.example.test"],
          enhancedEvidence: false,
        },
      });
      const command = issued.at(-1);
      if (command?.operation.type !== "capture")
        throw new Error("Expected a capture command");
      return { commandId: command.id, operation: command.operation };
    };
    const skip = (productId: string, operationId: string) =>
      skipProductEnrichment(
        ctx.db,
        {
          _runExecution: { runId, operationId },
          productId: productShortcode.parse(productId),
          reason: "No exact source page shows this variant.",
        },
        ctx.actor,
      );
    const targetState = async (targetId: string) => {
      const [row] = await getDb(ctx.db)
        .select({
          state: runTarget.state,
          outcome: runTarget.outcome,
          warning: runTarget.warning,
        })
        .from(runTarget)
        .where(eq(runTarget.id, targetId));
      return row;
    };
    return { runId, party, products, claim, capture, skip, targetState };
  }

  it("captures for the claimed target and moves past a skipped Product", async () => {
    const { runId, claim, capture, skip, targetState } = await worklist();
    const skippedTargets: string[] = [];
    for (const expected of [0, 1]) {
      const claimed = await claim();
      // Claim and capture agree even when every target shares createdAt.
      const { operation } = await capture(`capture-${expected}`);
      expect(operation.evidenceScope?.targetId).toBe(claimed.targetId);
      expect(await skip(claimed.productId, `skip-${expected}`)).toMatchObject({
        productId: claimed.productId,
        state: "skipped",
      });
      skippedTargets.push(claimed.targetId);
    }
    expect(new Set(skippedTargets).size).toBe(2);
    expect(await claimNextImportWork(ctx.db, namespace, runId)).toEqual({
      kind: "none",
    });
    await finishRun(ctx.db, namespace, { runId, operationId: "finish" });
    const [finished] = await getDb(ctx.db)
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, runId));
    expect(finished?.status).toBe("completed");
    for (const targetId of skippedTargets)
      expect(await targetState(targetId)).toEqual({
        state: "skipped",
        outcome: "skipped",
        warning: "No exact source page shows this variant.",
      });
  });

  // A capture still in flight when its Product is skipped answers later;
  // binding that evidence must not reopen the skipped target.
  it("keeps a skipped target skipped when its outstanding capture is imported later", async () => {
    const { runId, claim, capture, skip, targetState } = await worklist();
    const claimed = await claim();
    const { commandId } = await capture("capture-late");
    await skip(claimed.productId, "skip-late");
    const [evidence] = await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId,
        targetId: claimed.targetId,
        kind: "browser_capture",
        objectKey: `test/${crypto.randomUUID()}`,
        checksum: "e".repeat(64),
        mediaType: "application/pdf",
      })
      .returning({ id: runEvidence.id });
    results.set(commandId, {
      protocolVersion: 2,
      commandID: commandId,
      operationID: "browser-command:capture-late",
      runID: runId,
      completedAt: "2026-09-25T12:00:00.000Z",
      outcome: {
        status: "completed",
        capture: {
          sourceURL: "https://seed.example.test/products/basil",
          title: "Basil packet",
          capturedAt: "2026-09-25T12:00:00.000Z",
          captureVersion: 3,
          readableText: "Basil packet",
          links: [],
          images: [],
          paymentEvidence: [],
          evidence: [
            {
              id: evidence!.id,
              kind: "rendered_pdf",
              checksum: "e".repeat(64),
              contentType: "application/pdf",
            },
          ],
          variantMarkers: [],
        },
      },
    });
    await importBrowserOrderEvidence(ctx.db, namespace, {
      runId,
      operationId: "evidence-late",
      commandId,
    });
    expect(await targetState(claimed.targetId)).toEqual({
      state: "skipped",
      outcome: "skipped",
      warning: "No exact source page shows this variant.",
    });
    expect((await claim()).targetId).not.toBe(claimed.targetId);
  });

  // Any enrichment admission (a member's manual start included) must not
  // put a Product into a second concurrent run on another account.
  it("does not admit a Product another active run is enriching", async () => {
    const { party, products } = await worklist();
    const otherVendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Example Other Shop ${crypto.randomUUID()}`,
      website: "https://other.example.test",
      browserDomains: ["other.example.test"],
    });
    const otherAccount = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic other account",
      vendorId: otherVendor.id,
      ledgerPartyId: party.id,
      status: "active",
      browserSyncEnabled: true,
    });
    const second = await startTargetedRun(ctx.db, {
      ledgerPartyId: party.id,
      purpose: "product_enrichment",
      vendorId: otherVendor.id,
      vendorAccountId: otherAccount.id,
      trigger: "manual",
      targets: [
        {
          kind: "product",
          productId: products[0]!.entityId,
          sourceExternalKey: "https://other.example.test/",
          targetFingerprint: "f".repeat(64),
        },
      ],
    });
    expect(second).toEqual({ created: false, blockingRun: null });
  });

  // Restarting or re-dispatching an enrichment run brings its Products back
  // to life; a Product another run took meanwhile must not be enriched twice.
  it("refuses to restart or re-dispatch a run whose Product another active run holds", async () => {
    const { runId, party, products } = await worklist();
    const [run] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, runId));
    const otherVendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Example Other Shop ${crypto.randomUUID()}`,
      website: "https://other.example.test",
      browserDomains: ["other.example.test"],
    });
    const otherAccount = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic other account",
      vendorId: otherVendor.id,
      ledgerPartyId: party.id,
      status: "active",
      browserSyncEnabled: true,
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "dispatch_failed", coordinatorStartedAt: null })
      .where(eq(runTable.id, runId));
    const holder = await startTargetedRun(ctx.db, {
      ledgerPartyId: party.id,
      purpose: "product_enrichment",
      vendorId: otherVendor.id,
      vendorAccountId: otherAccount.id,
      trigger: "manual",
      targets: [
        {
          kind: "product",
          productId: products[0]!.entityId,
          sourceExternalKey: "https://other.example.test/",
          targetFingerprint: "f".repeat(64),
        },
      ],
    });
    expect(holder.created).toBe(true);
    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: run!.shortcode,
        action: "retry_dispatch",
      }),
    ).rejects.toThrow(/already being enriched/u);
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(runTable.id, runId));
    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: run!.shortcode,
        action: "restart",
      }),
    ).rejects.toThrow(/already being enriched/u);
  });

  it("returns the recorded result to a concurrent replay of one skip", async () => {
    const { claim, skip } = await worklist();
    const claimed = await claim();
    const [first, second] = await Promise.all([
      skip(claimed.productId, "skip-twice"),
      skip(claimed.productId, "skip-twice"),
    ]);
    expect(second).toEqual(first);
  });
});
