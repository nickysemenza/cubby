import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";

import { renderDetailFieldValue } from "~/entity/display/entity-display";
import type { KeyNumber } from "~/ui/common/key-numbers";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

type DisplayField = EntityFieldModel["fields"][number];

/** The record's declared `detail.hero.stats`, rendered as key numbers. */
export function detailHeroStats<E extends GenericDetailEntity>(
  entity: E,
  record: DetailRecordOf<E>,
): KeyNumber[] {
  const { hero }: CompiledEntityPresentation["detail"] =
    entitySummary[entity].detail;
  const fields: readonly DisplayField[] = entityFieldModels[entity].fields;
  return hero.stats.flatMap((key) => {
    const field = fields.find((candidate) => candidate.key === key);
    // A stat projected only on list reads (a list count) is absent from the
    // detail record; skip it rather than paint an empty cell.
    const absent =
      field?.readKey != null &&
      field.display.readPath === null &&
      !(field.readKey in record);
    return field && !absent
      ? [
          {
            label: field.label,
            value: renderDetailFieldValue(entity, record, field),
          },
        ]
      : [];
  });
}
