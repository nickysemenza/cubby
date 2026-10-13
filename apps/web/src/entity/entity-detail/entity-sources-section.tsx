import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySourceRead } from "@cubby/schemas/entity-source";
import { z } from "zod";

import { formatTimestamp } from "~/lib/date-format";
import { DateDisplay } from "~/ui/common/date-display";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { Badge } from "~/ui/primitives/badge";

/** Dates arrive serialized on some transports; the read shape otherwise matches. */
const sourceList = z.array(
  entitySourceRead.extend({
    observedAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
  }),
);
type Source = z.infer<typeof sourceList>[number];

/** The record's `sources` (entity detail read), or none when absent. */
export const recordSources = (record: unknown): Source[] =>
  sourceList
    .catch([])
    .parse(
      z
        .looseObject({ sources: z.unknown() })
        .catch({ sources: [] })
        .parse(record).sources ?? [],
    );

const recorderLabel = (recorder: Source["recorder"]) =>
  [recorder.runId, recorder.oauthClientId, recorder.channel]
    .filter(Boolean)
    .join(" · ");

/**
 * Generic Sources section: where facts about this record were seen. A
 * field-scoped source says whether it still supports the field's current
 * value or describes a value since overwritten.
 */
export function EntitySourcesSection({
  entity,
  sources,
}: {
  entity: Entity;
  sources: readonly Source[];
}) {
  const labelOf = (fieldPath: string) =>
    entityFieldModels[entity].fields.find((field) => field.key === fieldPath)
      ?.label ?? fieldPath;
  return (
    <RecordList aria-label="Sources">
      {sources.map((source) => (
        <RecordRow
          key={[
            source.createdAt.toISOString(),
            source.fieldPath,
            source.url,
            source.quote,
          ].join("|")}
          primary={
            <span className="flex flex-wrap items-center gap-1.5">
              {source.fieldPath ? (
                <>
                  <span className="font-medium">
                    {labelOf(source.fieldPath)}
                  </span>
                  <Badge
                    variant={source.supportsCurrentValue ? "positive" : "slate"}
                  >
                    {source.supportsCurrentValue
                      ? "Current value"
                      : "Earlier value"}
                  </Badge>
                </>
              ) : (
                <span className="font-medium">Record</span>
              )}
              {source.selectedVariant ? (
                <Badge variant="outline">{source.selectedVariant}</Badge>
              ) : null}
            </span>
          }
          secondary={
            source.url ? (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
                title={source.url}
              >
                {source.url}
              </a>
            ) : (
              `by ${recorderLabel(source.recorder)}`
            )
          }
          trailing={
            <span
              title={`Recorded ${formatTimestamp(source.createdAt)} by ${recorderLabel(source.recorder)}`}
            >
              {source.observedAt ? "Seen " : null}
              <DateDisplay timestamp={source.observedAt ?? source.createdAt} />
            </span>
          }
          detail={
            source.quote ? (
              <blockquote className="border-l-2 border-border pl-2 text-xs/5 text-muted-foreground">
                {source.quote}
              </blockquote>
            ) : null
          }
        />
      ))}
    </RecordList>
  );
}
