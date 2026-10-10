import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySourceRead } from "@cubby/schemas/entity-source";
import { z } from "zod";

import { formatInstant } from "~/lib/date-format";
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
    <ul className="flex flex-col gap-3">
      {sources.map((source) => (
        <li
          key={[
            source.createdAt.toISOString(),
            source.fieldPath,
            source.url,
            source.quote,
          ].join("|")}
          className="flex flex-col gap-1 text-sm"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {source.fieldPath ? (
              <>
                <span className="font-medium">{labelOf(source.fieldPath)}</span>
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
          </div>
          {source.quote ? (
            <blockquote className="border-l-2 border-border pl-2 text-muted-foreground">
              {source.quote}
            </blockquote>
          ) : null}
          {source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="truncate text-xs text-primary hover:underline"
            >
              {source.url}
            </a>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {source.observedAt
              ? `Seen ${formatInstant(source.observedAt, "dateShort")} · `
              : ""}
            Recorded {formatInstant(source.createdAt, "dateShort")} by{" "}
            {recorderLabel(source.recorder)}
          </span>
        </li>
      ))}
    </ul>
  );
}
