import { testUserId } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { listReadFields } from "~/entity/model/list-read-schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { createMcpServer } from "~/server/mcp/server";
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
});
