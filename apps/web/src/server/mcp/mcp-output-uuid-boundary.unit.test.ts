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
  // Image processing jobs are internal queue handles, not Image entity links.
  "image.jobIds[]",
  // A recipe line has no shortcode; recipe_insights.patch_line takes this id.
  "recipe_insights_read.recipes[].usages[].lineId",
  // MealRecipe has no shortcode. nutrition.plan_recipe exposes the newly inserted
  // occurrence handle that nutrition update/remove/save_preparation take.
  "nutrition.recipes[].id",
  "nutrition.mealRecipeId",
  "nutrition_read.preparations[].mealRecipeId",
  // Import findings are internal review proposals. Their own id is the write
  // handle for apply/dismiss, while proposed fixes retain the exact internal
  // rows the audited transaction would mutate; neither is an entity link.
  "activity_read.runFindings[].id",
  "activity_read.runFindings[].proposedFix.expenseId",
  "activity_read.runFindings[].proposedFix.productId",
  "activity_read.runFindings[].proposedFix.purchaseId",
  // Nullable row handles in the reviewed replacement snapshot participate in
  // the approval fingerprint and attribution comparison in applyFix.
  "activity_read.runFindings[].proposedFix.reviewedLineIdentities[].productId",
  "activity_read.runFindings[].proposedFix.reviewedLineIdentities[].distinctFrom[].productId",
  "activity_read.runFindings[].proposedFix.reviewedLineAttributions[].partyId",
  // The source observation a reconcile_source_order proposal was built from;
  // applyFix commits exactly that observation, never a newer one.
  "activity_read.runFindings[].proposedFix.observationId",
  // purchase_import.prepare_reconciliation echoes the finding id it reviewed
  // (the same row handle as activity.runFindings[].id) or the accepted source
  // order it reviewed, and its commits take those handles back. An accepted
  // source order has no shortcode, and photo candidates cite it so a caller
  // can prepare that order's reconciliation.
  "purchase_import.id",
  "purchase_import.sourceOrderId",
  // Review proposals and feedback use child-row handles with no shortcodes.
  "activity_read.duplicateProductIdentities[].assessmentId",
  "activity_read.duplicateProductIdentities[].pairs[].assessmentId",
  // Shipment evidence child rows have no shortcodes. These handles preserve
  // capture membership, timeline provenance and explicit source reassignment;
  // Shipment, Purchase, Email and Vendor entity references remain shortcodes.
  "shipments_read.timeline[].observationIds[]",
  // Newly exposed capabilities retain opaque workflow, audit and child-row
  // handles consumed by their matching follow-up actions. Entity references
  // in these outputs remain shortcodes.
  "activity.id",
  "ai_read.latestRunId",
  "ai.id",
  "entity_graph.proposals[].review.assessmentId",
  "image.deletedIds[]",
  "inventory.items[].product.externalIds[].id",
  "inventory.items[].product.unitMappings[].id",
  "inventory.item.product.externalIds[].id",
  "inventory.item.product.unitMappings[].id",
  "maintenance.nextCursor",
  "maintenance_read.items[].targetId",
  "maintenance_read.items[].sourceId",
  "maintenance_read.entries[].id",
  "nutrition.id",
  "photo_run_read.candidates[].purchaseLines[].acceptedSourceLines[].sourceOrderId",
  "product_enrichment.product.externalIds[].id",
  "purchase_import_read.items[].assessmentId",
  "purchase_import_read.items[].producer.evaluationId",
  "purchase_import_read.acceptedSourceOrders[].sourceOrderId",
  "run_read.entries[].commandId",
  "run.run.findings[].proposedFix.purchaseId",
  "run.run.findings[].proposedFix.observationId",
  "run.run.findings[].proposedFix.reviewedLineIdentities[].productId",
  "run.run.findings[].proposedFix.reviewedLineIdentities[].distinctFrom[].productId",
  "run.run.findings[].proposedFix.reviewedLineAttributions[].partyId",
  "run.run.findings[].proposedFix.expenseId",
  "run.run.findings[].proposedFix.productId",
  "shipments_read.observations[].observationId",
  "shipments_read.observations[].sourceCaptureId",
  "shipments_read.observations[].sourcePackageId",
  "shipments_read.observations[].captureIds[]",
  "suggestions_read.items[].id",
  "suggestions_read.items[].assessmentId",
  "suggestions_read.items[].evidence.assessmentId",
  "suggestions_read.items[].evidence.acceptanceReceipt.auditIds[]",
  "suggestions_read.items[].evidence.id",
  "suggestions_read.items[].evidence.review.assessmentId",
  "suggestions.assessmentId",
  "suggestions.items[].assessmentId",
  "suggestions.feedbackId",
  "suggestions.items[].feedbackId",
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
    collectUuidFindings(
      items,
      defs,
      toolName,
      `${path}[]`,
      ancestry,
      out,
      fieldContext,
    );
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
    const nullableIdentifier: JsonSchemaNode = {
      anyOf: [{ $ref: "#/definitions/identifier" }, { type: "null" }],
    };
    const defs = {
      identifier: { type: "string", format: "uuid" },
      row: {
        type: "object",
        properties: {
          id: nullableIdentifier,
          ids: { type: "array", items: { $ref: "#/definitions/identifier" } },
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
      "probe.left.ids[]",
      "probe.right.id",
      "probe.right.ids[]",
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
