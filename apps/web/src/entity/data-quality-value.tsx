import type { DataQuality } from "@cubby/schemas/data-quality";
import { scoredEntities } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import { AsteriskSimpleIcon } from "@phosphor-icons/react/dist/csr/AsteriskSimple";
import { z } from "zod";

import {
  dataQualityOptions,
  dataQualityStatusLabel,
} from "~/lib/data-quality-options";
import { EnumPill } from "~/ui/primitives/enum-pill";

import { FieldExplanation } from "./field-explanation";

export function DataQualityValue({
  quality,
  scored = true,
}: {
  quality?: Pick<DataQuality, "score" | "status">;
  scored?: boolean;
}) {
  if (!quality)
    return (
      <span
        className="text-muted-foreground"
        aria-label={scored ? "Quality unavailable" : "Quality not assessed"}
      >
        —
      </span>
    );
  const label = dataQualityStatusLabel(quality.status);
  // Exceptions-only completeness is a distinct state, not a plain 100: the
  // marker is visible and spoken, not color alone.
  const excepted = quality.status === "complete_with_exceptions";
  return (
    <EnumPill
      color={
        dataQualityOptions.find((option) => option.value === quality.status)
          ?.color
      }
      icon={excepted ? <AsteriskSimpleIcon weight="bold" /> : undefined}
      description={label}
      className="tabular-nums"
    >
      {quality.score === null ? (
        label
      ) : (
        // Caps keep an unresolved gap at 99 or below, so this never rounds
        // a gap up to 100.
        <>
          {Math.round(quality.score)}/100
          {excepted ? <span className="sr-only">, {label}</span> : null}
        </>
      )}
    </EnumPill>
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
