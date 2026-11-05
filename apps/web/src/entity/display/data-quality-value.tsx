import type { DataQuality } from "@cubby/schemas/data-quality";
import { dataQuality, scoredEntities } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import {
  fieldValueOf,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import { cn } from "cn";
import { z } from "zod";

import { dataQualityStatusLabel } from "~/lib/data-quality-options";
import { FieldValueMark } from "~/ui/derived/value-mark";
import { WhyValue } from "~/ui/derived/why-value";
import { useDenseCell } from "~/ui/values/stacked-value";

/**
 * Quality reads as what is missing, in its condition tone: warning for missing
 * data, destructive for a defect. A complete record stays quiet.
 */
export function DataQualityValue({
  quality,
  scored = true,
}: {
  quality?: Pick<DataQuality, "status"> & { missing: number };
  scored?: boolean;
}) {
  const dense = useDenseCell();
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
  if (quality.status === "not_assessed")
    return (
      <span className="text-xs text-muted-foreground" title={label}>
        {label}
      </span>
    );
  if (quality.missing === 0)
    return (
      <span className="text-muted-foreground" title={label}>
        {label}
      </span>
    );
  return (
    <span
      data-quality-status={quality.status}
      className={cn(
        "tabular-nums",
        quality.status === "defect" ? "text-destructive" : "text-warning-ink",
      )}
      title={label}
    >
      {quality.missing}
      {dense ? null : " missing"}
      <span className="sr-only">, {label}</span>
    </span>
  );
}

/** Card and specialist lists share the value and lazy explanation.
 * Missing-result marks never hide the explanation trigger. */
export function EntityQualityFact({
  entity,
  id,
  envelope,
}: {
  entity: Entity;
  id: string;
  envelope?: ReadableFieldEnvelope;
}) {
  const parsed = envelope
    ? dataQuality.safeParse(fieldValueOf(envelope)).data
    : undefined;
  const quality = parsed && { ...parsed, missing: parsed.gaps.length };
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <FieldValueMark envelope={envelope}>
        <DataQualityValue
          quality={quality}
          scored={z.enum(scoredEntities).safeParse(entity).success}
        />
      </FieldValueMark>
      <WhyValue
        entity={entity}
        id={id}
        field="dataQuality"
        label="Data quality"
        surface="list"
        resolution={envelope}
      />
    </div>
  );
}
