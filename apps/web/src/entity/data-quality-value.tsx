import type { DataQuality } from "@cubby/schemas/data-quality";
import { scoredEntities } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import { z } from "zod";

import { dataQualityOptions } from "~/lib/data-quality-options";
import { renderOptionCell } from "~/ui/data-table/columnHelpers";

import { FieldExplanation } from "./field-explanation";

export function DataQualityValue({
  quality,
  scored = true,
}: {
  quality?: DataQuality;
  scored?: boolean;
}) {
  return quality ? (
    renderOptionCell(
      quality.status,
      dataQualityOptions,
      `${Math.round(quality.score)}/100`,
    )
  ) : (
    <span className="text-muted-foreground">
      {scored ? "Unavailable" : "Not assessed"}
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
