import { describe, expect, it } from "vitest";
import { type JSONType, z } from "zod";

import { listMcpToolCatalog } from "./server";

// Schema walk: no OUTPUT schema exposes a uuid-shaped id outside the declared
// exceptions, driven off the live tool catalog.
//
// Unit tier, not integration: `listMcpToolCatalog()` builds the catalog from
// registered zod schemas without running a handler, so nothing here needs a
// database. This lived in mcp-shortcode-boundary.integration.test.ts until the
// test-tier audit; the assertion is unchanged.

type JsonSchemaNode = Extract<JSONType, { [key: string]: JSONType }>;

interface UuidFinding {
  tool: string;
  path: string;
  field: string;
  siblings: string[];
}

/** Exact permanent UUID exceptions. A newly exposed UUID must be named here
 * deliberately; field-name heuristics are intentionally not accepted. */
const DECLARED_UUID_OUTPUT_PATHS = new Set([
  // Product unit-mapping rows keep their uuid: it is the only handle
  // `syncProductUnitMappings` accepts to update a row in place (a mapping
  // resent without it is deleted and reinserted). Declared on product get/list
  // and on the products embedded in ingredient get/list — same row, same
  // write handle. See `productUnitMappingMcpEntityOut` in @cubby/schemas.
  "entity.item.product[].unitMappings[].id",
  "entity.item.unitMappings[].id",
  "entity.items[].product[].unitMappings[].id",
  "entity.items[].unitMappings[].id",
  "find_recipes_using_ingredient.recipes[].usages[].lineId",
  "get_entities.item.product[].unitMappings[].id",
  "get_entities.item.unitMappings[].id",
  "get_entities.items[].product[].unitMappings[].id",
  "get_entities.items[].unitMappings[].id",
  "get_meal_preparations.preparations[].mealRecipeId",
  // Import findings are internal review proposals. Their own id is the write
  // handle for apply/dismiss, while proposed fixes retain the exact internal
  // rows the audited transaction would mutate; neither is an entity link.
  "list_problems.importFindings[].id",
  "list_problems.importFindings[].proposedFix.expenseId",
  "list_problems.importFindings[].proposedFix.productId",
  "list_problems.importFindings[].proposedFix.purchaseId",
  "remove_meal_recipe.recipes[].id",
  "save_meal_recipe_preparation.mealRecipeId",
  "update_meal_recipe.recipes[].id",
]);

const NOT_YET_CUT_OVER: string[] = [];

/** Recursively walk a JSON Schema (draft-7, as advertised by `tools/list`),
 * resolving `$ref`/`$defs` and `anyOf`/`oneOf`/`allOf` branches, collecting
 * every leaf typed `{format: "uuid"}` — the signature `z.uuid()` (and every
 * branded id built on it, see `identifiers.ts`'s `brandedId`) leaves in the
 * advertised schema. */
function collectUuidFindings(
  node: JsonSchemaNode,
  defs: Record<string, JsonSchemaNode>,
  toolName: string,
  path: string,
  visited: Set<unknown>,
  out: UuidFinding[],
) {
  if (visited.has(node)) return;
  visited.add(node);

  const ref = node["$ref"];
  if (isJsonString(ref)) {
    const refName = ref.split("/").pop();
    const target = refName ? defs[refName] : undefined;
    if (target) collectUuidFindings(target, defs, toolName, path, visited, out);
    return;
  }

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[key];
    if (isJsonArray(branches)) {
      for (const branch of branches) {
        if (isJsonSchemaNode(branch)) {
          collectUuidFindings(branch, defs, toolName, path, visited, out);
        }
      }
    }
  }

  const items = node["items"];
  if (node["type"] === "array" && isJsonSchemaNode(items)) {
    collectUuidFindings(items, defs, toolName, `${path}[]`, visited, out);
  }

  const properties = node["properties"];
  if (isJsonSchemaMap(properties)) {
    const siblings = Object.keys(properties);
    for (const [field, value] of Object.entries(properties)) {
      if (value["format"] === "uuid") {
        out.push({ tool: toolName, path: `${path}.${field}`, field, siblings });
      }
      collectUuidFindings(
        value,
        defs,
        toolName,
        `${path}.${field}`,
        visited,
        out,
      );
    }
  }
}

function isJsonString(value: JSONType | undefined): value is string {
  return typeof value === "string";
}

function isJsonArray(value: JSONType | undefined): value is JSONType[] {
  return Array.isArray(value);
}

function isJsonSchemaNode(
  value: JSONType | undefined,
): value is JsonSchemaNode {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function isJsonSchemaMap(
  value: JSONType | undefined,
): value is Record<string, JsonSchemaNode> {
  return (
    isJsonSchemaNode(value) &&
    Object.values(value).every((entry) => isJsonSchemaNode(entry))
  );
}

describe("MCP output schemas expose shortcodes, not uuids, outside declared exceptions", () => {
  it("walks every registered tool's OUTPUT schema off the live catalog", async () => {
    const { tools } = await listMcpToolCatalog();
    expect(tools.length).toBeGreaterThan(50);

    const violations: UuidFinding[] = [];
    const matchedDeclarations = new Set<string>();
    for (const tool of tools) {
      const parsedOutputSchema = z.json().safeParse(tool.outputSchema);
      if (!parsedOutputSchema.success) continue;
      const outputSchema = parsedOutputSchema.data;
      if (!isJsonSchemaNode(outputSchema)) continue;
      const defs =
        (isJsonSchemaMap(outputSchema["$defs"]) && outputSchema["$defs"]) ||
        (isJsonSchemaMap(outputSchema["definitions"]) &&
          outputSchema["definitions"]) ||
        {};
      const found: UuidFinding[] = [];
      collectUuidFindings(
        outputSchema,
        defs,
        tool.name,
        tool.name,
        new Set(),
        found,
      );
      violations.push(
        ...found.filter((f) => !DECLARED_UUID_OUTPUT_PATHS.has(f.path)),
      );
      for (const f of found) matchedDeclarations.add(f.path);
    }

    // Asserted as an EXACT set, not a subset: a new leak fails here, and so
    // does fixing one without striking it off the backlog. That keeps the list
    // shrinking rather than quietly becoming a permanent allowlist.
    expect(
      violations.map((v) => v.path).sort(),
      `uuid-shaped output fields changed.\nAdded (fix or declare):\n${violations
        .map(
          (v) => `  ${v.tool}: ${v.path} (siblings: ${v.siblings.join(", ")})`,
        )
        .join("\n")}`,
    ).toEqual([...NOT_YET_CUT_OVER].sort());

    // The other half of "keeps the list shrinking", which the assertion above
    // cannot see: a declared path whose field is no longer uuid-shaped never
    // appears in `found`, so it never shows up as a violation and the entry
    // survives forever. That is exactly how a dozen image paths outlived the
    // `IMG-` shortcode migration here. Fixing a leak must now also mean
    // striking it off, or this fails.
    const dead = [...DECLARED_UUID_OUTPUT_PATHS]
      .filter((path) => !matchedDeclarations.has(path))
      .sort();
    expect(
      dead,
      `declared uuid exceptions that no longer match anything.\nThese are cut over — delete them from DECLARED_UUID_OUTPUT_PATHS:\n${dead
        .map((p) => `  ${p}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
