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
  "attach_file.imageId",
  "get_product.images[].id",
  "get_vendor.logo.id",
  "patch_product_external_ids.images[].id",
  "create_meal.recipes[].id",
  "find_recipes_using_ingredient.recipes[].usages[].lineId",
  "get_meal.recipes[].id",
  "get_recipe.images[].id",
  "get_recipe.sections[].id",
  "get_recipe.sections[].ingredients[].id",
  "list_meals.items[].recipes[].id",
  "list_vendors.items[].logo.id",
  "remove_meal_recipe.recipes[].id",
  "update_meal.recipes[].id",
  "update_meal_recipe.recipes[].id",
  "create_vendor.logo.id",
  "update_vendor.logo.id",
  "merge_vendors.logo.id",
  "verify_product_images.images[].id",
  // Plural mirrors of the singular exceptions above. A batch tool wraps its
  // singular's own output in `results[].item`, so it re-exposes exactly the
  // same declared-uuid leaves — image ids and the mealRecipe row id, neither of
  // which has a shortcode.
  "attach_files.results[].item.imageId",
  "create_meals.results[].item.recipes[].id",
  "update_meals.results[].item.recipes[].id",
  "patch_products_external_ids.results[].item.images[].id",
  "verify_products_images.results[].item.images[].id",
  "create_vendors.results[].item.logo.id",
  "update_vendors.results[].item.logo.id",
  // The staged-upload handle. It IS an Image id, and images are a declared
  // exception with no shortcode — the caller hands this straight back to
  // attach_file, so it is the identifier rather than a leaked internal.
  "create_file_upload.uploadId",
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
  });
});
