import type { Entity } from "@cubby/schemas/entity-core";
import type { RelatednessOut } from "@cubby/schemas/relatedness";

type Item = RelatednessOut["items"][number];

/** Merge evidence once per record; display-only overlaps cannot inflate rank. */
export function buildRelatednessLedger(
  entity: Entity,
  contributions: readonly Omit<Item, "entity">[],
): Item[] {
  const ledger = new Map<string, Item>();
  for (const contribution of contributions) {
    const existing = ledger.get(contribution.shortcode);
    if (existing) {
      existing.score += contribution.score;
      existing.evidence.push(...contribution.evidence);
    } else
      ledger.set(contribution.shortcode, {
        ...contribution,
        evidence: [...contribution.evidence],
        entity,
      });
  }
  return [...ledger.values()].sort(
    (a, b) =>
      b.score - a.score ||
      a.title.localeCompare(b.title) ||
      a.shortcode.localeCompare(b.shortcode),
  );
}
