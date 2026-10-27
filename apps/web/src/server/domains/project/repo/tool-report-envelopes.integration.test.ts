import { fieldValueOf } from "@cubby/schemas/field-envelope";
import {
  projectResourceOut,
  toolGalleryInventoryEntryOut,
} from "@cubby/schemas/project";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { buildKernelContext } from "tooling/scenarios/context";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { productHandlers } from "~/server/domains/product/operations/product.server";
import { projectHandlers } from "~/server/domains/project/operations.server";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { executeEntityAs } from "~/server/entity-kernel";
import { publicFieldEnvelopeRows } from "~/server/generic/derived/repo/public-read";
import { systemPrincipal } from "~/server/http/authenticate";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { attachProjectResources } from "./tools";

let queue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  queue = captureBackgroundQueue();
});
afterEach(() => queue.restore());

describe("live tool report field envelopes", () => {
  const ctx = withTestDb();
  const request = () => ({
    principal: systemPrincipal(buildKernelContext(ctx.db, ctx.actor.userId)),
    headers: new Headers(),
    signal: new AbortController().signal,
  });

  it("uses canonical Product, Inventory and Project fields at real operation boundaries", async () => {
    const project = await createRepoEntity(ctx, "project", {
      name: "Synthetic tool project",
      kind: "workshop",
      emoji: "🔧",
      status: "in_progress",
    });
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic report drill",
        categoryId: taxonomyShortcode("tools"),
        brandId: await findOrCreateVendor(ctx.db, "Synthetic report brand"),
      }),
      ctx.actor,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic tool shelf" }),
      ctx.actor,
    );
    const inventory = await createInventoryFixture(
      ctx.db,
      {
        productId: product.id,
        locationId: location.id,
        amount: { value: 2, unit: "each" },
        placement: "stock",
      },
      ctx.actor,
    );
    await createRepoEntity(ctx, "expense", {
      name: "Synthetic drill acquisition",
      productId: product.id,
      projectId: project.output.id,
      lineKind: "principal",
      trade: "cabinetry",
      costType: "tools",
      cost: 240,
    });

    const gallery = await projectHandlers.operations.toolGallery({
      data: {},
      request: request(),
    });
    expect(gallery.ok).toBe(true);
    if (!gallery.ok) throw new Error(gallery.error.message);
    const tool = gallery.data.items.find((row) => row.productId === product.id);
    if (!tool) throw new Error("Synthetic tool missing from gallery");
    expect(fieldValueOf(tool.fields.brandName)).toBe("Synthetic report brand");
    expect(tool).not.toHaveProperty("brandName");
    expect(tool).not.toHaveProperty("id");
    const entry = tool.inventoryEntries.find((row) => row.id === inventory.id);
    if (!entry) throw new Error("Synthetic placement missing from gallery");
    expect(fieldValueOf(entry.fields.amount)).toEqual({
      value: 2,
      unit: "each",
    });
    expect(entry).not.toHaveProperty("amount");
    for (const ancestor of entry.location.ancestors)
      expect(ancestor).not.toHaveProperty("type");

    const suggestions = await projectHandlers.operations.toolSuggestions({
      data: { projectId: project.output.id },
      request: request(),
    });
    expect(suggestions.ok).toBe(true);
    if (!suggestions.ok) throw new Error(suggestions.error.message);
    const suggestion = suggestions.data.items.find(
      (row) => row.productId === product.id,
    );
    if (!suggestion)
      throw new Error("Synthetic purchase missing from suggestions");
    expect(fieldValueOf(suggestion.fields.brandName)).toBe(
      "Synthetic report brand",
    );
    expect(suggestion).not.toHaveProperty("brandName");
    expect(suggestion.projectPurchaseCost).toBe(240);

    await attachProjectResources(
      ctx.db,
      project.entityId,
      [product.entityId],
      ctx.actor,
    );
    const relation = await executeEntityAs(
      buildKernelContext(ctx.db, ctx.actor.userId),
      "listRelation",
      {
        entity: "project",
        relation: "resources",
        id: project.output.id,
        offset: 0,
        limit: 50,
      },
    );
    const resource = projectResourceOut
      .array()
      .parse(relation.items)
      .find((row) => row.productId === product.id);
    if (!resource) throw new Error("Synthetic resource relation missing");
    expect(fieldValueOf(resource.fields.brandName)).toBe(
      "Synthetic report brand",
    );
    expect(resource).not.toHaveProperty("brandName");

    const matrix = await projectHandlers.operations.toolMatrix({
      data: { minNetLifetimeCost: 0 },
      request: request(),
    });
    expect(matrix.ok).toBe(true);
    if (!matrix.ok) throw new Error(matrix.error.message);
    const column = matrix.data.columns.find(
      (row) => row.projectId === project.output.id,
    );
    if (!column) throw new Error("Synthetic Project missing from matrix");
    expect(fieldValueOf(column.fields.emoji)).toBe("🔧");
    expect(fieldValueOf(column.fields.kind)).toBe("workshop");
    expect(column).not.toHaveProperty("emoji");
    expect(column).not.toHaveProperty("kind");
    const matrixTool = matrix.data.rows.find(
      (row) => row.productId === product.id,
    );
    if (!matrixTool) throw new Error("Synthetic Product missing from matrix");
    expect(fieldValueOf(matrixTool.fields.brandName)).toBe(
      "Synthetic report brand",
    );
    expect(matrixTool).not.toHaveProperty("brandName");

    const uses = await productHandlers.operations.projectUses({
      data: { productId: product.id },
      request: request(),
    });
    expect(uses.ok).toBe(true);
    if (!uses.ok) throw new Error(uses.error.message);
    expect(fieldValueOf(uses.data.fields.brandName)).toBe(
      "Synthetic report brand",
    );
    const use = uses.data.projects.find(
      (row) => row.projectId === project.output.id,
    );
    if (!use) throw new Error("Synthetic Project use missing");
    expect(fieldValueOf(use.fields.kind)).toBe("workshop");
    expect(use).not.toHaveProperty("kind");

    // A repeated report snapshot cannot replace authoritative current quantity.
    const raw = { ...entry, amount: { value: 99, unit: "each" } };
    const read = (count: number) =>
      countTestDbQueries(() =>
        publicFieldEnvelopeRows({
          db: ctx.db,
          entity: "inventory",
          schema: toolGalleryInventoryEntryOut,
          rows: Array.from({ length: count }, () => raw),
        }),
      );
    const single = await read(1);
    const repeated = await read(20);
    expect(repeated.queryCount).toBe(single.queryCount);
    expect(repeated.result).toHaveLength(20);
    for (const row of repeated.result)
      expect(fieldValueOf(row.fields.amount)).toEqual({
        value: 2,
        unit: "each",
      });
  });
});
