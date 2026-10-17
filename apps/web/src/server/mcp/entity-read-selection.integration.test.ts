import { testUserId } from "@cubby/schemas/testing";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { listEntities } from "~/entity/generated/entity-lists.gen";
import { listEnrichmentGroups } from "~/entity/model/list-read-fields";
import { listReadFields } from "~/entity/model/list-read-schema";
import { unwrapDb } from "~/server/db/helpers";
import { entityExternalId } from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import {
  buildKernelContext,
  seedReferenceUniverse,
} from "~/server/entity-kernel/reference-universe.fixtures";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";
import { generatedMcpEntityActionEntities } from "~/server/generated/entity-kernel-entities.gen";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { createMcpServer } from "~/server/mcp/server";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  callMcpTool,
  kernelRequestContext,
  withTestClient,
} from "../testing/mcp-test-utils";
import type { ToolArguments } from "./tools/tool-registration";

const rows = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
});
const one = z.object({ item: z.record(z.string(), z.unknown()) });

type JsonSchemaNode =
  | boolean
  | {
      type?: unknown;
      items?: JsonSchemaNode;
      properties?: Record<string, JsonSchemaNode>;
      additionalProperties?: JsonSchemaNode;
      anyOf?: JsonSchemaNode[];
      oneOf?: JsonSchemaNode[];
      allOf?: JsonSchemaNode[];
    };
const jsonSchemaNode: z.ZodType<JsonSchemaNode> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.looseObject({
      type: z.unknown().optional(),
      items: jsonSchemaNode.optional(),
      properties: z.record(z.string(), jsonSchemaNode).optional(),
      additionalProperties: jsonSchemaNode.optional(),
      anyOf: z.array(jsonSchemaNode).optional(),
      oneOf: z.array(jsonSchemaNode).optional(),
      allOf: z.array(jsonSchemaNode).optional(),
    }),
  ]),
);
const variants = (
  node: JsonSchemaNode | undefined,
): Exclude<JsonSchemaNode, boolean>[] => {
  if (typeof node !== "object") return [];
  const nested: JsonSchemaNode[] = [
    ...(node.anyOf ?? []),
    ...(node.oneOf ?? []),
    ...(node.allOf ?? []),
  ];
  return [node, ...nested.flatMap(variants)];
};
const declaresObject = (node: JsonSchemaNode | undefined) =>
  variants(node).some(
    (variant) => variant.type === "object" || variant.properties !== undefined,
  );
const declaresObjectCollection = (node: JsonSchemaNode | undefined) =>
  variants(node).some(
    (variant) =>
      declaresObject(variant.items) ||
      declaresObject(variant.additionalProperties),
  );

/**
 * Compact is an identity-and-status row: no collections of objects (an empty
 * one included), no data-quality facets or gaps, no field resolutions.
 */
function compactViolations(
  entity: keyof typeof ENTITY_SCHEMA_BINDINGS,
  item: z.output<typeof rows>["items"][number],
): string[] {
  const found: string[] = [];
  // An empty collection can't be classified from its value; read the schema.
  const published = jsonSchemaNode.parse(
    z.toJSONSchema(ENTITY_SCHEMA_BINDINGS[entity].mcpList, {
      io: "output",
      unrepresentable: "any",
    }),
  );
  for (const key of Object.keys(item))
    if (
      typeof published === "object" &&
      declaresObjectCollection(published.properties?.[key])
    )
      found.push(
        `${entity} compact ${key} is declared a collection of objects`,
      );
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      if (value.some((entry) => typeof entry === "object" && entry !== null))
        found.push(`${entity} compact ${path} is a collection of objects`);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (["facets", "gaps", "fieldResolutions"].includes(key))
        found.push(`${entity} compact carries ${at}`);
      visit(child, at);
    }
  };
  visit(item, "");
  return found;
}

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

  it("compact returns declared list fields without child collections", async () => {
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

  // Regression: compact asked the selected-field reader for a field it never
  // loaded (financialTransaction sourceRefsLabel), and `fields` re-parsed rows
  // through `.partial()`, which throws on refined object schemas. The client
  // validates every structured result against the published outputSchema.
  it("serves compact and field selections for every entity_read kind", async () => {
    await seedReferenceUniverse(ctx.db);
    const entityKernel = entityKernelContextSchema.parse(
      buildKernelContext(ctx.db),
    );
    const listed = new Set<string>(generatedMcpEntityActionEntities.list);
    const failures = await withTestClient(
      createMcpServer(),
      kernelRequestContext(entityKernel),
      { entityKernel },
      async (client) => {
        await client.listTools();
        const failed: string[] = [];
        const call = async (command: ToolArguments) => {
          const label = `${String(command["action"])} ${String(command["entity"])} ${JSON.stringify(command["fields"] ?? command["resultDetail"])}`;
          try {
            const result = await client.callTool({
              name: "entity_read",
              arguments: command,
            });
            if (result.isError)
              failed.push(`${label}: ${JSON.stringify(result.content)}`);
            return result;
          } catch (error) {
            failed.push(`${label}: ${String(error)}`);
            return null;
          }
        };
        for (const entity of listEntities) {
          if (!listed.has(entity)) continue;
          const declared = listReadFields(entity);
          const fields = [
            ...declared.core.filter((field) => field !== "id").slice(0, 1),
            ...listEnrichmentGroups.flatMap((group) =>
              declared[group].slice(0, 1),
            ),
          ];
          const listedCompact = rows.safeParse(
            (await call({ action: "list", entity, resultDetail: "compact" }))
              ?.structuredContent,
          ).data?.items[0];
          await call({ action: "list", entity, fields });
          if (listedCompact)
            failed.push(...compactViolations(entity, listedCompact));
          const id = z.string().optional().parse(listedCompact?.["id"]);
          if (!id) continue;
          // A get selects from the published detail schema, not the list one.
          const detail: z.core.$ZodType =
            ENTITY_SCHEMA_BINDINGS[entity].mcpDetail;
          const detailFields =
            detail instanceof z.ZodObject
              ? fields.filter((field) => Object.hasOwn(detail.shape, field))
              : [];
          const gotCompact = one.safeParse(
            (
              await call({
                action: "get",
                entity,
                id,
                resultDetail: "compact",
              })
            )?.structuredContent,
          ).data?.item;
          await call({ action: "get", entity, id, fields: detailFields });
          if (gotCompact) {
            failed.push(...compactViolations(entity, gotCompact));
            const listKeys = Object.keys(listedCompact ?? {});
            const getKeys = Object.keys(gotCompact);
            const onlyList = listKeys.filter((key) => !getKeys.includes(key));
            const onlyGet = getKeys.filter((key) => !listKeys.includes(key));
            if (onlyList.length > 0 || onlyGet.length > 0)
              failed.push(
                `${entity} compact keys differ: list-only ${onlyList.join(",")}; get-only ${onlyGet.join(",")}`,
              );
          }
        }
        return failed;
      },
    );
    expect(failures).toEqual([]);
  }, 180_000); // Four reads per entity across the full matrix.
});
