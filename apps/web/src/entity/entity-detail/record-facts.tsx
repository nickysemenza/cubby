import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { onDetailSurface } from "@cubby/schemas/entity-detail-summary";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { entityMetadata } from "~/entity/metadata";
import { FactsDensityProvider } from "~/ui/records/facts";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { railFieldKeys, summaryFieldKeys } from "./detail-summary";
import { EntityRecordFields } from "./entity-record-fields";
import { headerLinesOf } from "./record-header";
import { QualitySectionChecks } from "./record-quality";

/** The card shows at least a row of facts before "All N facts". */
const LEADING_FACTS = 4;

/**
 * The labelled AI-written summary, held to three lines until the member asks
 * for the rest.
 */
export function RecordAiSummary({
  text,
  attribution,
}: {
  text: string;
  attribution: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-label="AI-written summary"
      className="max-w-3xl min-w-0 pt-1 text-sm"
    >
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
 * The facts card: every singular fact of the record as a label over its
 * value, the declared summary fields first and the rest behind "All N facts".
 * The summary card states the recorded declared lines, so an unrecorded line
 * is a fact like any other and keeps its Add control. Each field section
 * keeps its fragment and its section-level quality results here, and a link
 * to a fact behind "All N facts" opens them.
 */
export function RecordFacts<E extends GenericDetailEntity>({
  entity,
  record,
  columns,
}: {
  entity: E;
  record: DetailRecordOf<E>;
  /** Four in a page's main column, two in the inspector. */
  columns: 2 | 4;
}) {
  const queryClient = useQueryClient();
  const [all, setAll] = useState(false);
  const host = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const open = () => setAll(true);
    element.addEventListener("record-facts-reveal", open);
    return () => element.removeEventListener("record-facts-reveal", open);
  }, []);
  const detail: CompiledEntityPresentation["detail"] = entityMetadata(
    queryClient,
    entity,
  ).summary.detail;
  const fieldSections = detail.sections.filter(
    (section) => section.kind === "fields" && onDetailSurface(section, "web"),
  );
  const model: readonly EntityFieldModel["fields"][number][] = entityMetadata(
    queryClient,
    entity,
  ).fields.fields;
  const lines = headerLinesOf(queryClient, entity, record);
  const drawn = new Set(
    detail.lines
      .filter((line) => lines.some((shown) => shown.label === line.label))
      .map((line) => line.field),
  );
  const fields = railFieldKeys(queryClient, entity, record).filter(
    (key) =>
      !drawn.has(key) &&
      model.find((candidate) => candidate.key === key)?.display.detail,
  );
  if (fields.length === 0 && fieldSections.length === 0) return null;
  const summaryFields = new Set([
    ...detail.lines.map((line) => line.field),
    ...summaryFieldKeys(queryClient, entity),
  ]);
  const declared = fields.filter((key) => summaryFields.has(key));
  const leading = [
    ...declared,
    ...fields
      .filter((key) => !summaryFields.has(key))
      .slice(0, Math.max(0, LEADING_FACTS - declared.length)),
  ];
  const rest = fields.filter((key) => !leading.includes(key));
  return (
    <section
      ref={host}
      aria-label="Facts"
      data-record-facts
      data-columns={columns}
      className="record-card record-facts"
    >
      <FactsDensityProvider density="compact">
        <div className="record-facts-grid">
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
          <EntityRecordFields
            entity={entity}
            record={record}
            fields={leading}
          />
          {rest.length > 0 ? (
            <div data-facts-more hidden={!all}>
              <EntityRecordFields
                entity={entity}
                record={record}
                fields={rest}
              />
            </div>
          ) : null}
        </div>
      </FactsDensityProvider>
      {rest.length > 0 ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((value) => !value)}
          className="mt-3 rounded-sm text-sm font-medium text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
        >
          {all ? "Fewer facts" : `All ${fields.length} facts`}
        </button>
      ) : null}
    </section>
  );
}
