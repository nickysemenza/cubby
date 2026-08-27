import { describe, expect, it } from "vitest";
import { listMcpToolCatalog } from "./server";

// Schema walk: no OUTPUT schema exposes a uuid-shaped id outside the declared
// exceptions, driven off the live tool catalog.
//
// Unit tier, not integration: `listMcpToolCatalog()` builds the catalog from
// registered zod schemas without running a handler, so nothing here needs a
// database. This lived in mcp-shortcode-boundary.integration.test.ts until the
// test-tier audit; the assertion is unchanged.

type JsonSchemaNode = Record<string, unknown>;

interface UuidFinding {
  tool: string;
  path: string;
  field: string;
  siblings: string[];
}

/** Exact permanent UUID exceptions. A newly exposed UUID must be named here
 * deliberately; field-name heuristics are intentionally not accepted. */
const DECLARED_UUID_OUTPUT_PATHS = new Set([
  "add_recipe_to_meal.recipes[].id",
  "find_recipes_using_ingredient.recipes[].usages[].lineId",
  "remove_meal_recipe.recipes[].id",
  "update_meal_recipe.recipes[].id",
]);

const NOT_YET_CUT_OVER: string[] = [];

/** Recursively walk a JSON Schema (draft-7, as advertised by `tools/list`),
 * resolving `$ref`/`$defs` and `anyOf`/`oneOf`/`allOf` branches, collecting
 * every leaf typed `{format: "uuid"}` — the signature `z.uuid()` (and every
 * branded id built on it, see `identifiers.ts`'s `brandedId`) leaves in the
 * advertised schema. */
function collectUuidFindings(
  node: unknown,
  defs: Record<string, JsonSchemaNode>,
  toolName: string,
  path: string,
  visited: Set<unknown>,
  out: UuidFinding[],
) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  if (visited.has(node)) return;
  visited.add(node);
  const schema = node as JsonSchemaNode;

  if (typeof schema.$ref === "string") {
    const refName = schema.$ref.split("/").pop();
    const target = refName ? defs[refName] : undefined;
    if (target) collectUuidFindings(target, defs, toolName, path, visited, out);
    return;
  }

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        collectUuidFindings(branch, defs, toolName, path, visited, out);
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    collectUuidFindings(
      schema.items,
      defs,
      toolName,
      `${path}[]`,
      visited,
      out,
    );
  }

  const properties = schema.properties as
    | Record<string, JsonSchemaNode>
    | undefined;
  if (properties) {
    const siblings = Object.keys(properties);
    for (const [field, value] of Object.entries(properties)) {
      if (!value || typeof value !== "object") continue;
      if (value.format === "uuid") {
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

describe("MCP output schemas expose shortcodes, not uuids, outside declared exceptions", () => {
  it("walks every registered tool's OUTPUT schema off the live catalog", async () => {
    const { tools } = await listMcpToolCatalog();
    expect(tools.length).toBeGreaterThan(50);

    const violations: UuidFinding[] = [];
    const matchedDeclarations = new Set<string>();
    for (const tool of tools) {
      const outputSchema = tool.outputSchema as JsonSchemaNode | undefined;
      if (!outputSchema) continue;
      const defs =
        (outputSchema.$defs as Record<string, JsonSchemaNode> | undefined) ??
        (outputSchema.definitions as
          | Record<string, JsonSchemaNode>
          | undefined) ??
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
