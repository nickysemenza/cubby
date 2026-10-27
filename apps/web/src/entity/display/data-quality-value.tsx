import type { DataQuality } from "@cubby/schemas/data-quality";
import { dataQuality, scoredEntities } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import {
  fieldValueOf,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import { AsteriskSimpleIcon } from "@phosphor-icons/react/dist/csr/AsteriskSimple";
import { z } from "zod";

import { dataQualityStatusLabel } from "~/lib/data-quality-options";
import { cn } from "~/lib/utils";
import { useDenseCell } from "~/ui/common/stacked-value";
import { FieldValueMark } from "~/ui/derived/value-mark";
import { WhyValue } from "~/ui/derived/why-value";

const METER_BARS = 5;

/** Filled bars for a score below 100: one per full fifth, at least one. */
export const qualityMeterFill = (score: number) =>
  Math.min(METER_BARS - 1, Math.max(1, Math.floor(score / 20)));

/**
 * Quality scores stay visible, including complete records.
 * A gap shows a five-bar meter in its condition tone —
 * warning for missing data, destructive for a defect — beside the score.
 */
export function DataQualityValue({
  quality,
  scored = true,
}: {
  quality?: Pick<DataQuality, "score" | "status">;
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
  if (quality.status === "complete")
    return (
      <span className="text-muted-foreground tabular-nums" title={label}>
        {quality.score}
        {dense ? null : "/100"}
        <span className="sr-only">, {label}</span>
      </span>
    );
  if (quality.score === null || quality.status === "not_assessed")
    return (
      <span className="text-xs text-muted-foreground" title={label}>
        {label}
      </span>
    );
  // Caps keep an unresolved gap at 99 or below, so this never rounds a gap
  // up to 100.
  const score = Math.round(quality.score);
  // Exceptions-only completeness is a distinct state, not a plain 100: the
  // marker is visible and spoken, not color alone.
  if (quality.status === "complete_with_exceptions")
    return (
      <span className="text-muted-foreground tabular-nums" title={label}>
        {score}
        <AsteriskSimpleIcon
          weight="bold"
          aria-hidden
          className="inline size-2 align-super"
        />
        <span className="sr-only">, {label}</span>
      </span>
    );
  const tone = quality.status === "defect" ? "bg-destructive" : "bg-warning";
  const filled = qualityMeterFill(score);
  return (
    <span
      data-quality-meter={quality.status}
      className="inline-flex items-center gap-1.5 tabular-nums"
      title={`${label} · ${score}/100`}
    >
      <span aria-hidden className="inline-flex gap-px">
        {Array.from({ length: METER_BARS }, (_, index) => (
          <i
            key={index}
            className={cn(
              "block h-2.5 w-[3px] rounded-[1px]",
              index < filled ? tone : "bg-border",
            )}
          />
        ))}
      </span>
      <span>
        {score}
        {dense ? null : "/100"}
        <span className="sr-only">, {label}</span>
      </span>
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
  const quality = envelope
    ? dataQuality.safeParse(fieldValueOf(envelope)).data
    : undefined;
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
      />
    </div>
  );
}
