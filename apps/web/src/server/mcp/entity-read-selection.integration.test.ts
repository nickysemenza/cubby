import { testUserId } from "@cubby/schemas/testing";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { unwrapDb } from "~/server/db/helpers";
import { entityExternalId } from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { ENTITY_REPOSITORY_READ_SCHEMAS } from "~/server/generated/entity-bindings.gen";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";
import { createMcpServer } from "~/server/mcp/server";
import {
  createProductIdentityFixture,
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
      cost: 1250n,
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
      fields: [
        "fields.expenseTotal",
        "fields.financialReconciliation.result.decision.outcome.value.status",
      ],
    });
    expect(listed.isError).not.toBe(true);
    const [item] = rows.parse(listed.structuredContent).items;
    expect(item).toEqual({
      id: purchase.shortcode,
      fields: {
        expenseTotal: expect.objectContaining({
          result: expect.objectContaining({
            decision: expect.objectContaining({
              outcome: { kind: "value", value: 12.5 },
            }),
          }),
        }),
        financialReconciliation: {
          result: {
            decision: { outcome: { value: { status: expect.any(String) } } },
          },
        },
      },
    });
    const covered = await read({
      action: "list",
      entity: "purchase",
      fields: ["displayCover"],
    });
    expect(covered.isError).not.toBe(true);
    expect(rows.parse(covered.structuredContent).items).toEqual([
      { id: purchase.shortcode, displayCover: { image: null, count: 0 } },
    ]);
    const detailCover = await read({
      action: "get",
      entity: "purchase",
      id: purchase.shortcode,
      fields: ["displayCover"],
    });
    expect(detailCover.isError).toBe(true);
    expect(JSON.stringify(detailCover)).toContain("MCP_FIELD_UNKNOWN");
    const got = await read({
      action: "get",
      entity: "purchase",
      id: purchase.shortcode,
      fields: ["id", "fields.expenseTotal"],
    });
    expect(one.parse(got.structuredContent).item).toEqual({
      id: purchase.shortcode,
      fields: {
        expenseTotal: expect.objectContaining({
          result: expect.objectContaining({
            decision: expect.objectContaining({
              outcome: { kind: "value", value: 12.5 },
            }),
          }),
        }),
      },
    });
  });

  it("compact returns declared list fields without child collections", async () => {
    await world();
    const listed = await read({
      action: "list",
      entity: "purchase",
      resultDetail: "compact",
    });
    expect(listed.isError).not.toBe(true);
    const declared = new Set(
      Object.keys(ENTITY_REPOSITORY_READ_SCHEMAS["purchase"].schema.shape),
    );
    const [item] = rows.parse(listed.structuredContent).items;
    expect(item).toHaveProperty(
      "fields.expenseTotal.result.decision.outcome.value",
      12.5,
    );
    for (const [key, value] of Object.entries(item!)) {
      const selectedKeys =
        key === "fields"
          ? Object.keys(z.record(z.string(), z.json()).parse(value))
          : [key];
      expect(
        selectedKeys.every(
          (selected) => selected === "id" || declared.has(selected),
        ),
      ).toBe(true);
      expect(
        Array.isArray(value) &&
          value.some((entry) => typeof entry === "object" && entry !== null),
      ).toBe(false);
    }
  });

  it("serves a name-only Location list without requiring unloaded governed fields", async () => {
    const location = await insertWithShortcode(ctx.db, "location", {
      name: "Synthetic selected cupboard",
      type: "room",
    });
    const selected = await read({
      action: "list",
      entity: "location",
      fields: ["name"],
      filters: { ids: [location.shortcode] },
    });
    expect(selected.isError).not.toBe(true);
    expect(rows.parse(selected.structuredContent).items).toEqual([
      { id: location.shortcode, name: "Synthetic selected cupboard" },
    ]);
    const governed = await read({
      action: "list",
      entity: "location",
      fields: ["fields.type"],
      filters: { ids: [location.shortcode] },
    });
    expect(governed.isError).not.toBe(true);
    expect(rows.parse(governed.structuredContent).items).toMatchObject([
      {
        id: location.shortcode,
        fields: {
          type: {
            current: { assignment: { kind: "value", value: "room" } },
            result: { decision: { outcome: { kind: "value", value: "room" } } },
          },
        },
      },
    ]);
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
    expect(text).toContain("fields");
  });

  it("refuses an unknown nested segment and keeps valid nested paths", async () => {
    await world();
    const refused = await read({
      action: "list",
      entity: "purchase",
      fields: ["fields.financialReconciliation.notAField"],
    });
    expect(refused.isError).toBe(true);
    const text = JSON.stringify(refused.content);
    expect(text).toContain("MCP_FIELD_UNKNOWN");
    expect(text).toContain("fields.financialReconciliation.notAField");
    const valid = await read({
      action: "list",
      entity: "purchase",
      fields: [
        "fields.financialReconciliation.result.decision.outcome.value.status",
      ],
    });
    expect(valid.isError).not.toBe(true);
  });

  // Selection must narrow the published MCP projection, never the raw kernel
  // row: product externalIds child rows carry storage uuids the projection drops.
  it("selects from the published projection, not the raw kernel row", async () => {
    const created = await createProductIdentityFixture(
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
      fields: ["fields.stockTracked.result.decision.outcome.value"],
    });
    expect(resolved.isError).not.toBe(true);
    expect(one.parse(resolved.structuredContent).item).toEqual({
      id: child.shortcode,
      fields: {
        stockTracked: { result: { decision: { outcome: { value: false } } } },
      },
    });

    const created = await createProductIdentityFixture(
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
