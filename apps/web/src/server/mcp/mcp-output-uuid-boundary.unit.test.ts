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
  "entity_read.item.product[].unitMappings[].id",
  "entity_read.item.unitMappings[].id",
  "entity_read.items[].product[].unitMappings[].id",
  "entity_read.items[].unitMappings[].id",
  // A recipe line has no shortcode; recipe_import.patch_line takes this id.
  "recipe_insights.recipes[].usages[].lineId",
  // MealRecipe has no shortcode. meal_recipe.add exposes the newly inserted
  // occurrence handle that meal_recipe update/remove/save_preparation take.
  "meal_recipe.mealRecipeId",
  "meal_recipe.recipes[].id",
  "nutrition.preparations[].mealRecipeId",
  // Import findings are internal review proposals. Their own id is the write
  // handle for apply/dismiss, while proposed fixes retain the exact internal
  // rows the audited transaction would mutate; neither is an entity link.
  "activity.runFindings[].id",
  "activity.runFindings[].proposedFix.expenseId",
  "activity.runFindings[].proposedFix.productId",
  "activity.runFindings[].proposedFix.purchaseId",
  // Nullable row handles in the reviewed replacement snapshot participate in
  // the approval fingerprint and attribution comparison in applyFix.
  "activity.runFindings[].proposedFix.reviewedLineIdentities[].productId",
  "activity.runFindings[].proposedFix.reviewedLineAttributions[].partyId",
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
  fieldContext?: Pick<UuidFinding, "field" | "siblings">,
) {
  if (visited.has(node)) return;
  const ancestry = new Set([...visited, node]);
  if (node["format"] === "uuid" && fieldContext) {
    out.push({ tool: toolName, path, ...fieldContext });
  }

  const ref = node["$ref"];
  if (isJsonString(ref)) {
    const refName = ref.split("/").pop();
    const target = refName ? defs[refName] : undefined;
    if (target) {
      collectUuidFindings(
        target,
        defs,
        toolName,
        path,
        ancestry,
        out,
        fieldContext,
      );
    }
    return;
  }

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[key];
    if (isJsonArray(branches)) {
      for (const branch of branches) {
        if (isJsonSchemaNode(branch)) {
          collectUuidFindings(
            branch,
            defs,
            toolName,
            path,
            ancestry,
            out,
            fieldContext,
          );
        }
      }
    }
  }

  const items = node["items"];
  if (node["type"] === "array" && isJsonSchemaNode(items)) {
    collectUuidFindings(items, defs, toolName, `${path}[]`, ancestry, out);
  }

  const properties = node["properties"];
  if (isJsonSchemaMap(properties)) {
    const siblings = Object.keys(properties);
    for (const [field, value] of Object.entries(properties)) {
      collectUuidFindings(
        value,
        defs,
        toolName,
        `${path}.${field}`,
        ancestry,
        out,
        { field, siblings },
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
  it("checks every path through shared references while stopping cycles", () => {
    const defs = {
      identifier: { type: "string", format: "uuid" },
      row: {
        type: "object",
        properties: {
          id: {
            anyOf: [{ $ref: "#/definitions/identifier" }, { type: "null" }],
          },
          next: { $ref: "#/definitions/row" },
        },
      },
    } satisfies Record<string, JsonSchemaNode>;
    const findings: UuidFinding[] = [];
    collectUuidFindings(
      {
        type: "object",
        properties: {
          left: { $ref: "#/definitions/row" },
          right: { $ref: "#/definitions/row" },
        },
      },
      defs,
      "probe",
      "probe",
      new Set(),
      findings,
    );
    expect(findings.map((finding) => finding.path)).toEqual([
      "probe.left.id",
      "probe.right.id",
    ]);
  });
  it("walks every registered tool's OUTPUT schema off the live catalog", async () => {
    const { tools } = await listMcpToolCatalog();

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
