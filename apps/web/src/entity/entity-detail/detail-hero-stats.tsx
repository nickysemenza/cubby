import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";

import { renderDetailFieldValue } from "~/entity/display/entity-display";
import type { DetailHeroStat } from "~/entity/page/page-hero";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

type DisplayField = EntityFieldModel["fields"][number];

/** The record's declared `detail.hero.stats`, rendered as key numbers. */
export function detailHeroStats<E extends GenericDetailEntity>(
  entity: E,
  record: DetailRecordOf<E>,
): DetailHeroStat[] {
  const { hero }: CompiledEntityPresentation["detail"] =
    entitySummary[entity].detail;
  const fields: readonly DisplayField[] = entityFieldModels[entity].fields;
  return hero.stats.flatMap((key) => {
    const field = fields.find((candidate) => candidate.key === key);
    return field
      ? [
          {
            label: field.label,
            value: renderDetailFieldValue(entity, record, field),
          },
        ]
      : [];
  });
}

/** Key numbers in a panel too narrow for the page strip: a two-up grid. */
export function KeyNumbersGrid({
  stats,
}: {
  stats: readonly DetailHeroStat[];
}) {
  if (stats.length === 0) return null;
  return (
    <dl
      className="grid grid-cols-2 border-b border-border"
      data-testid="inspector-key-numbers"
    >
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="min-w-0 border-border px-4 py-2 odd:border-r [&:nth-child(n+3)]:border-t"
        >
          <dt className="truncate text-xs font-medium text-muted-foreground">
            {stat.label}
          </dt>
          <dd className="mt-0.5 truncate text-base font-semibold text-foreground-strong tabular-nums [&_*]:text-inherit">
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
