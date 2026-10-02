import type { DataQuality } from "@cubby/schemas/data-quality";
import { scoredEntities } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import { z } from "zod";

import { dataQualityOptions } from "~/lib/data-quality-options";
import { EnumPill } from "~/ui/primitives/enum-pill";

import { FieldExplanation } from "./field-explanation";

export function DataQualityValue({
  quality,
  scored = true,
}: {
  quality?: Pick<DataQuality, "score" | "status">;
  scored?: boolean;
}) {
  return quality ? (
    <EnumPill
      color={
        dataQualityOptions.find((option) => option.value === quality.status)
          ?.color
      }
      className="tabular-nums"
    >
      {Math.round(quality.score)}/100
    </EnumPill>
  ) : (
    <span
      className="text-muted-foreground"
      aria-label={scored ? "Quality unavailable" : "Quality not assessed"}
    >
      —
    </span>
  );
}

/** Card and specialist lists share the table's value and lazy explanation. */
export function EntityQualityFact({
  entity,
  id,
  quality,
}: {
  entity: Entity;
  id: string;
  quality?: DataQuality;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <DataQualityValue
        quality={quality}
        scored={z.enum(scoredEntities).safeParse(entity).success}
      />
      <FieldExplanation
        entity={entity}
        id={id}
        field="dataQuality"
        label="Data quality"
        surface="list"
      />
    </div>
  );
}
