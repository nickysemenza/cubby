import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { onDetailSurface } from "@cubby/schemas/entity-detail-summary";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { entityMetadata } from "~/entity/metadata";
import { Facts, FactsDensityProvider } from "~/ui/records/facts";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { railFieldKeys } from "./detail-summary";
import { EntityRecordFields } from "./entity-record-fields";
import { headerLinesOf } from "./record-header";
import { QualitySectionChecks } from "./record-quality";

/**
 * The labelled AI-written summary, held to three lines until the member asks
 * for the rest.
 */
export function RailAiSummary({
  text,
  attribution,
}: {
  text: string;
  attribution: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="AI-written summary" className="min-w-0 text-sm">
      <p className="mb-0.5 flex items-start gap-1 text-xs text-muted-foreground">
        <SparkleIcon
          aria-hidden
          weight="bold"
          className="mt-0.5 size-3 shrink-0"
        />
        {attribution}
      </p>
      <p
        className={
          open
            ? "whitespace-pre-line text-foreground"
            : "line-clamp-3 whitespace-pre-line text-foreground"
        }
      >
        {text}
      </p>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="rounded-sm text-xs text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
      >
        {open ? "Less" : "More"}
      </button>
    </section>
  );
}

/**
 * Every singular fact of the record as one definition list: the declared
 * lines, the summary's fields and each field section's fields. Each field
 * section keeps its fragment and its section-level quality results here.
 */
export function RailFacts<E extends GenericDetailEntity>({
  entity,
  record,
}: {
  entity: E;
  record: DetailRecordOf<E>;
}) {
  const queryClient = useQueryClient();
  const sections: CompiledEntityPresentation["detail"]["sections"] =
    entityMetadata(queryClient, entity).summary.detail.sections;
  const fieldSections = sections.filter(
    (section) => section.kind === "fields" && onDetailSurface(section, "web"),
  );
  const model: readonly EntityFieldModel["fields"][number][] = entityMetadata(
    queryClient,
    entity,
  ).fields.fields;
  const detail: CompiledEntityPresentation["detail"] = entityMetadata(
    queryClient,
    entity,
  ).summary.detail;
  // A recorded line keeps its declared label and link; an unrecorded one is
  // a field like any other, so its Add control stays reachable.
  const lines = headerLinesOf(queryClient, entity, record);
  const drawn = new Set(
    detail.lines
      .filter((line) => lines.some((drawn) => drawn.label === line.label))
      .map((line) => line.field),
  );
  const fields = railFieldKeys(queryClient, entity, record).filter(
    (key) =>
      !drawn.has(key) &&
      model.find((candidate) => candidate.key === key)?.display.detail,
  );
  if (fields.length + lines.length === 0 && fieldSections.length === 0)
    return null;
  return (
    <section aria-label="Facts" data-record-facts className="min-w-0">
      {fieldSections.map((section) => (
        <div
          key={section.id}
          id={section.id}
          tabIndex={-1}
          data-rail-section
          className="outline-none focus-visible:outline-2 focus-visible:outline-ring"
        >
          <QualitySectionChecks section={section.id} />
        </div>
      ))}
      <FactsDensityProvider density="compact">
        <Facts
          layout="list"
          facts={lines.map((line) => ({
            label: line.label,
            value: line.value,
            className: line.figure ? "font-mono tabular-nums" : undefined,
          }))}
        />
        <EntityRecordFields entity={entity} record={record} fields={fields} />
      </FactsDensityProvider>
    </section>
  );
}
