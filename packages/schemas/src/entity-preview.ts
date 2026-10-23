import type { Entity } from "./entity";
import { entitySummary } from "./generated/entity-summary.gen";

/** One ordered roster for hover previews, graph cards, and compact records. */
export function entityPreviewFieldKeys(entity: Entity): readonly string[] {
  const { detail, titleField } = entitySummary[entity];
  if (detail.preview.length) return detail.preview;
  const section = detail.sections.find((item) => item.kind === "fields");
  return [
    ...new Set([
      ...detail.summary.flatMap((slot) =>
        slot.kind === "fields" ? slot.fields : [],
      ),
      ...(section?.kind === "fields" ? section.fields : []),
    ]),
  ].filter(
    (key) =>
      key !== titleField &&
      key !== detail.hero.chip &&
      key !== detail.hero.breadcrumb,
  );
}
