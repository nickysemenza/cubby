import { testUserId } from "@cubby/schemas/testing";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { listReadFields } from "~/entity/model/list-read-schema";
import { unwrapDb } from "~/server/db/helpers";
import { entityExternalId } from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { createMcpServer } from "~/server/mcp/server";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { callMcpTool, kernelRequestContext } from "../testing/mcp-test-utils";
import type { ToolArguments } from "./tools/tool-registration";

const rows = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
});
const one = z.object({ item: z.record(z.string(), z.unknown()) });

// A full list of a few dozen purchases exceeded the MCP output limit; field
// selection and the compact preset keep reads bounded without per-entity lists.
describe("entity_read field selection", () => {
  const ctx = withTestDb();
  const read = async (command: ToolArguments) => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    return callMcpTool(
      createMcpServer(),
      "entity_read",
      command,
      kernelRequestContext(entityKernel),
      { entityKernel },
    );
  };
  const world = async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic selection vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: purchase.id,
      name: "Synthetic selection line",
      cost: 12.5,
      date: "2026-09-01",
      costType: "materials",
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
      economicRole: "vendor",
    });
    return { vendor, purchase };
  };

  it("returns only the requested fields and dot paths, always with id", async () => {
    const { purchase } = await world();
    const listed = await read({
      action: "list",
      entity: "purchase",
      fields: ["expenseTotal", "financialReconciliation.status"],
    });
    expect(listed.isError).not.toBe(true);
    const [item] = rows.parse(listed.structuredContent).items;
    expect(item).toEqual({
      id: purchase.shortcode,
      expenseTotal: 12.5,
      financialReconciliation: { status: expect.any(String) },
    });
    const got = await read({
      action: "get",
      entity: "purchase",
      id: purchase.shortcode,
      fields: ["id", "expenseTotal"],
    });
    expect(one.parse(got.structuredContent).item).toEqual({
      id: purchase.shortcode,
      expenseTotal: 12.5,
    });
  });

  it("compact returns declared list fields without nested child collections", async () => {
    await world();
    const listed = await read({
      action: "list",
      entity: "purchase",
      resultDetail: "compact",
    });
    expect(listed.isError).not.toBe(true);
    const declared = new Set(Object.values(listReadFields("purchase")).flat());
    const [item] = rows.parse(listed.structuredContent).items;
    expect(item).toHaveProperty("expenseTotal", 12.5);
    for (const [key, value] of Object.entries(item!)) {
      expect(key === "id" || declared.has(key)).toBe(true);
      expect(
        Array.isArray(value) &&
          value.some((entry) => typeof entry === "object" && entry !== null),
      ).toBe(false);
    }
  });

  it("refuses an unknown field path naming the allowed keys", async () => {
    await world();
    const refused = await read({
      action: "list",
      entity: "purchase",
      fields: ["notAField.status"],
    });
    expect(refused.isError).toBe(true);
    const text = JSON.stringify(refused.content);
    expect(text).toContain("BAD_REQUEST");
    expect(text).toContain("notAField");
    expect(text).toContain("expenseTotal");
  });

  it("refuses an unknown nested segment and keeps valid nested paths", async () => {
    await world();
    const refused = await read({
      action: "list",
      entity: "purchase",
      fields: ["financialReconciliation.notAField"],
    });
    expect(refused.isError).toBe(true);
    const text = JSON.stringify(refused.content);
    expect(text).toContain("MCP_FIELD_UNKNOWN");
    expect(text).toContain("financialReconciliation.notAField");
    const valid = await read({
      action: "list",
      entity: "purchase",
      fields: ["financialReconciliation.status"],
    });
    expect(valid.isError).not.toBe(true);
  });

  // Selection must narrow the published MCP projection, never the raw kernel
  // row: product externalIds child rows carry storage uuids the projection drops.
  it("selects from the published projection, not the raw kernel row", async () => {
    const created = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic selection product" }),
      TEST_ACTOR,
    );
    await ensureExternalSources(ctx.db, ["synthetic"]);
    await unwrapDb(ctx.db).insert(entityExternalId).values({
      entityId: created.entityId,
      entityKind: "product",
      source: "synthetic",
      kind: "retailer_sku",
      externalId: "SYN-SKU-1",
      isPrimary: true,
    });
    const uuid =
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const command of [
      { action: "list", entity: "product", fields: ["externalIds"] },
      {
        action: "get",
        entity: "product",
        id: created.id,
        fields: ["externalIds"],
      },
    ] as const) {
      const result = await read(command);
      expect(result.isError).not.toBe(true);
      const text = JSON.stringify(result.structuredContent);
      expect(text).toContain("SYN-SKU-1");
      expect(text).not.toMatch(uuid);
    }
  });

  it("selects through record and array parents and returns their values", async () => {
    const parent = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `Synthetic pantry ${crypto.randomUUID()}`,
      stockTracked: false,
    });
    const child = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `Synthetic spices ${crypto.randomUUID()}`,
      parentId: parent.id,
    });
    const resolved = await read({
      action: "get",
      entity: "spendingCategory",
      id: child.shortcode,
      fields: ["fieldResolutions.stockTracked.value"],
    });
    expect(resolved.isError).not.toBe(true);
    expect(one.parse(resolved.structuredContent).item).toEqual({
      id: child.shortcode,
      fieldResolutions: { stockTracked: { value: false } },
    });

    const created = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic array selection product" }),
      TEST_ACTOR,
    );
    await ensureExternalSources(ctx.db, ["synthetic"]);
    await unwrapDb(ctx.db)
      .insert(entityExternalId)
      .values(
        ["SYN-SKU-A", "SYN-SKU-B"].map((externalId, index) => ({
          entityId: created.entityId,
          entityKind: "product" as const,
          source: "synthetic",
          kind: "retailer_sku" as const,
          externalId,
          isPrimary: index === 0,
        })),
      );
    const listed = await read({
      action: "get",
      entity: "product",
      id: created.id,
      fields: ["externalIds.externalId"],
    });
    expect(listed.isError).not.toBe(true);
    const item = one.parse(listed.structuredContent).item;
    expect(item).toEqual({
      id: created.id,
      externalIds: expect.arrayContaining([
        { externalId: "SYN-SKU-A" },
        { externalId: "SYN-SKU-B" },
      ]),
    });
    expect(item["externalIds"]).toHaveLength(2);
  });
});
