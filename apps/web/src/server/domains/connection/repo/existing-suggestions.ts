import type { EntityRef } from "@cubby/schemas/entity";
import {
  connectionProposal,
  type ConnectionProposal,
  type ConnectionRelation,
} from "@cubby/schemas/entity-connections";

import type { Database } from "~/server/db";
import { resolveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { readFieldSuggestions } from "~/server/generic/suggestions/repo/field-gaps";

const fieldRelations = new Map<string, ConnectionRelation>(
  Object.entries({
    "task.subjectProductId": "task-subject-product",
    "product.ingredientId": "product-ingredient",
    "product.growsPlantId": "product-grows-plant",
    "cookbook.productId": "cookbook-product",
    "device.productId": "device-product",
    "expense.productId": "product-expense",
    "expense.projectId": "expense-project",
    "inventory.locationId": "inventory-location",
  } satisfies Record<string, ConnectionRelation>),
);

const key = (source: EntityRef) => `${source.entityKind}:${source.entityId}`;

/** Read current field Answers and identity gaps through their owners. */
export async function readExistingConnectionSuggestions(
  db: Database,
  sources: readonly EntityRef[],
): Promise<ConnectionProposal[][]> {
  if (!sources.length) return [];
  const proposals: ConnectionProposal[] = [];
  if (sources.some((source) => source.entityKind === "product")) {
    const { getProductMatchQueue } =
      await import("~/server/domains/product/repo/match/product-match-review");
    const queue = await getProductMatchQueue(db, {});
    for (const row of queue.items) {
      const parsed = connectionProposal.safeParse({
        relation: "product-identity",
        source: { entityKind: "product", entityId: row.keeper.id },
        target: { entityKind: "product", entityId: row.other.id },
        label: "Review Product identity",
        evidence: {
          reasons: row.evidence ? [row.evidence] : [],
          contradictions: row.conflictReasons,
          unknowns: row.actionable ? [] : ["Product identity needs evidence"],
        },
        fingerprint: row.fingerprint,
        review: {
          suggestionId: row.suggestionId,
          suppression: null,
          family: "product_pair",
        },
        integration: { kind: "product-pair-review" },
      });
      if (parsed.success) proposals.push(parsed.data);
    }
  }
  const fresh = new Set(proposals);
  const fields = await readFieldSuggestions(db);
  const refs = await resolveShortcodes(
    db,
    fields.flatMap((row) =>
      typeof row.suggestedValue === "string"
        ? [row.recordId, row.suggestedValue]
        : [],
    ),
  );
  for (const row of fields) {
    const relation = fieldRelations.get(`${row.entity}.${row.field}`);
    if (!relation || typeof row.suggestedValue !== "string") continue;

    const target = refs.get(row.suggestedValue);
    if (!target) continue;
    const parsed = connectionProposal.safeParse({
      relation,
      source: { entityKind: row.entity, entityId: row.recordId },
      target: { entityKind: target.entity, entityId: row.suggestedValue },
      label: `Review ${row.field}`,
      evidence: { reasons: ["Field Answer"], contradictions: [], unknowns: [] },
      fingerprint: row.id,
      review: { suggestionId: row.id, suppression: null },
      integration: { kind: "field-review", field: row.field },
    });
    if (parsed.success) {
      proposals.push(parsed.data);
      fresh.add(parsed.data);
    }
  }

  return sources.map((source) =>
    proposals.filter(
      (proposal) =>
        (key(proposal.source) === key(source) ||
          key(proposal.target) === key(source)) &&
        fresh.has(proposal),
    ),
  );
}
