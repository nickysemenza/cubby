import { type ProductId, productShortcode } from "@cubby/schemas/identifiers";
import type {
  BrowserBridgeRequest,
  BrowserStructuredProducts,
} from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityExternalId,
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

import {
  commitProductEnrichment,
  skipProductEnrichment,
} from "./import-orders";
import { productEnrichmentTarget } from "./product-enrichment-target";
import {
  claimNextImportWork,
  finishRun,
  issueBrowserCommand,
  startTargetedRun,
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
    return { target: { id: target.entityId }, commit, commitImage };
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
  const broker = {
    enqueue: async (command: BrowserBridgeRequest) => {
      issued.push(command);
    },
    result: async () => null,
    cancel: async () => undefined,
    connected: async () => true,
    pendingCommands: async () => [],
    notifyRunCompleted: async () => undefined,
    requestAuthentication: async () => undefined,
  };
  const namespace = { getByName: () => broker };

  it("captures for the claimed target and moves past a skipped Product", async () => {
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
    const targetIds = new Map(
      (
        await getDb(ctx.db)
          .select({ id: runTarget.id, productId: runTarget.entityId })
          .from(runTarget)
          .where(eq(runTarget.runId, runId))
      ).map((row) => [row.id, row.productId]),
    );
    const captureFor = async (operationId: string) => {
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
      return command?.operation.type === "capture"
        ? command.operation.evidenceScope?.targetId
        : undefined;
    };

    for (const expected of [0, 1]) {
      const claimed = await claimNextImportWork(ctx.db, namespace, runId);
      if (claimed.kind !== "product_enrichment" || !("targetId" in claimed))
        throw new Error(`Expected enrichment work, got ${claimed.kind}`);
      // Claim and capture agree even when every target shares createdAt.
      expect(await captureFor(`capture-${expected}`)).toBe(claimed.targetId);
      expect(targetIds.get(claimed.targetId)).toBeDefined();
      const skipped = await skipProductEnrichment(
        ctx.db,
        {
          _runExecution: { runId, operationId: `skip-${expected}` },
          productId: productShortcode.parse(claimed.productId),
          reason: "No exact source page shows this variant.",
        },
        ctx.actor,
      );
      expect(skipped).toMatchObject({
        productId: claimed.productId,
        state: "skipped",
      });
    }
    expect(await claimNextImportWork(ctx.db, namespace, runId)).toEqual({
      kind: "none",
    });
    await finishRun(ctx.db, namespace, { runId, operationId: "finish" });
    const [finished] = await getDb(ctx.db)
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, runId));
    expect(finished?.status).toBe("completed");
    expect(
      await getDb(ctx.db)
        .select({
          state: runTarget.state,
          outcome: runTarget.outcome,
          warning: runTarget.warning,
        })
        .from(runTarget)
        .where(eq(runTarget.runId, runId)),
    ).toEqual([
      {
        state: "skipped",
        outcome: "skipped",
        warning: "No exact source page shows this variant.",
      },
      {
        state: "skipped",
        outcome: "skipped",
        warning: "No exact source page shows this variant.",
      },
    ]);
  });
});
