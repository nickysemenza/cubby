import { auditEntitySchema } from "@cubby/schemas/audit";
import type { Entity } from "@cubby/schemas/entity";
import {
  fieldExplanationSource,
  type FieldExplanationOutput,
} from "@cubby/schemas/field-explanation";
import type { FieldResolution } from "@cubby/schemas/field-resolution";
import { inventoryShortcode } from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  inventory,
  fieldExplanation,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/utils";
import { CELL_RAIL_BUTTON_CLASS } from "~/ui/data-table/cell-frame";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { NoneValue } from "~/ui/primitives/none-value";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/ui/primitives/popover";

import {
  FieldResolutionEntityActions,
  FieldResolutionStatus,
} from "./field-resolution";
import {
  ResolutionExplanation,
  sectionLabelClassName,
} from "./field-resolution-explanation";

type ExplanationSource = z.infer<typeof fieldExplanationSource>;
export type ExplanationValue = ExplanationSource["value"];
const explanationScalar = z.union([z.string(), z.number(), z.boolean()]);
const explanationRecord = z.record(z.string(), z.json());

const humanizeKey = (key: string) =>
  key
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());

export function ReadableExplanationValue({
  value,
  depth = 0,
  property,
}: {
  value: ExplanationValue;
  depth?: number;
  property?: string;
}) {
  if (value === null) return <NoneValue />;
  const textValue = z.string().safeParse(value);
  const reference = textValue.success ? parseShortcode(textValue.data) : null;
  if (reference)
    return (
      <ExplanationEntityLink entity={reference.type} id={reference.shortcode} />
    );
  const amount = property === "amount" ? z.number().safeParse(value) : null;
  if (amount?.success)
    return (
      <span className="font-mono tabular-nums">
        {formatCurrency(amount.data)}
      </span>
    );
  const scalar = explanationScalar.safeParse(value);
  if (scalar.success) {
    const boolean = z.boolean().safeParse(scalar.data);
    const display = boolean.success
      ? boolean.data
        ? "Yes"
        : "No"
      : scalar.data;
    return <span className="break-words">{display}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <NoneValue />;
    const occurrences = new Map<string, number>();
    return (
      <ul className="grid gap-1 pl-4 text-xs">
        {value.map((item) => {
          const contentKey = JSON.stringify(item);
          const occurrence = occurrences.get(contentKey) ?? 0;
          occurrences.set(contentKey, occurrence + 1);
          return (
            <li key={`${contentKey}:${occurrence}`} className="list-disc">
              <ReadableExplanationValue value={item} depth={depth + 1} />
            </li>
          );
        })}
      </ul>
    );
  }
  const record = explanationRecord.safeParse(value);
  if (!record.success) return <span>Unavailable</span>;
  if (depth >= 2) {
    const summary = Object.entries(record.data)
      .filter(([, item]) => explanationScalar.safeParse(item).success)
      .slice(0, 3)
      .map(([key, item]) => `${humanizeKey(key)}: ${String(item)}`)
      .join(" · ");
    return <span>{summary || "Supporting details"}</span>;
  }
  return (
    <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
      {Object.entries(record.data).map(([key, item]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{humanizeKey(key)}</dt>
          <dd className="min-w-0">
            <ReadableExplanationValue
              value={item}
              depth={depth + 1}
              property={key}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}

const explanationSourceKey = (source: ExplanationSource): string =>
  [
    source.label,
    source.entity?.entityKind ?? "value",
    source.entity?.entityId ?? JSON.stringify(source.value),
  ].join(":");

/** The resolution row already names its source record, so a bare
 * link-only source pointing at the same record adds nothing. */
function visibleSources(data: FieldExplanationOutput) {
  const named = data.resolution?.sourceEntity;
  if (!named) return data.sources;
  return data.sources.filter(
    (source) =>
      source.value !== null ||
      source.entity?.entityKind !== named.entityKind ||
      source.entity.entityId !== named.entityId,
  );
}

export function ExplanationEntityLink({
  entity,
  id,
  name,
}: {
  entity: Entity;
  id: string;
  name?: string | null;
}) {
  const auditable = auditEntitySchema.safeParse(entity);
  return auditable.success ? (
    <EntityRefLink
      variant="byId"
      entityKind={auditable.data}
      entityId={id}
      name={name}
    />
  ) : (
    <span className="font-mono text-xs">{id}</span>
  );
}

type FieldExplanationProps = {
  entity: Entity;
  id: string;
  field: string;
  label: string;
  surface?: "list" | "detail" | "summary";
  resolution?: FieldResolution | null;
};

export function FieldExplanation({
  entity,
  id,
  field,
  label,
  surface = "detail",
  resolution,
}: FieldExplanationProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            // Off the list rail, the 44px phone target is an `::after`
            // (24px + 2×10px) so a ledger row keeps its value on one line.
            mobileSize={surface === "list" ? "touch" : "compact"}
            className={
              surface === "list"
                ? CELL_RAIL_BUTTON_CLASS
                : "relative after:absolute after:-inset-2.5 md:after:hidden"
            }
            aria-label={`How ${label.toLowerCase()} is determined`}
          />
        }
      >
        {resolution ? (
          <FieldResolutionStatus resolution={resolution} compact />
        ) : (
          <InfoIcon className={surface === "list" ? "size-3" : "size-3.5"} />
        )}
      </PopoverTrigger>
      <PopoverContent className="max-h-[min(32rem,80dvh)] w-80 overflow-y-auto">
        {open ? (
          <FieldExplanationContents
            entity={entity}
            id={id}
            field={field}
            label={label}
            surface={surface}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Query observers and actions mount only while the explanation is open. */
function FieldExplanationContents({
  entity,
  id,
  field,
  label,
  surface = "detail",
}: FieldExplanationProps) {
  const result = useQuery({
    ...fieldExplanation.explain.queryOptions({
      entityKind: entity,
      entityId: id,
      field,
      surface,
    }),
  });
  const subjectAction = (target: { entityKind: Entity; entityId: string }) =>
    target.entityKind === entity && target.entityId === id;
  // minmax(0,1fr): grid tracks otherwise size to their widest nowrap child
  // (the truncated rule footer), pushing content past the popover edge.
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <PopoverTitle className={sectionLabelClassName}>
          <span className="sr-only">How </span>
          {label}
          <span className="sr-only"> is determined</span>
        </PopoverTitle>
        {result.data ? (
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {result.data.rule.id} · r{result.data.rule.revision}
          </span>
        ) : null}
      </header>
      {result.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : result.isError ? (
        <Stack gap="sm">
          <ErrorDisplay error={result.error} title="this explanation" />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void result.refetch()}
            disabled={result.isFetching}
          >
            Retry explanation
          </Button>
        </Stack>
      ) : (
        <>
          {result.data.resolution ? (
            <ResolutionExplanation
              entity={entity}
              id={id}
              field={field}
              resolution={result.data.resolution}
              evidence={result.data.resolutionEvidence}
            />
          ) : result.data.value !== null ||
            !result.data.sources.some(
              (source) =>
                source.label === "Project share" ||
                source.label === "Unassigned share",
            ) ? (
            <div className="text-base font-semibold break-words">
              <ReadableExplanationValue value={result.data.value} />
            </div>
          ) : null}
          {visibleSources(result.data).length > 0 ? (
            <section className="grid gap-1.5">
              <h3 className={sectionLabelClassName}>Evidence</h3>
              <dl className="grid gap-2">
                {visibleSources(result.data).map((source) => (
                  <div
                    key={explanationSourceKey(source)}
                    className="grid gap-0.5"
                  >
                    <dt className="text-muted-foreground">{source.label}</dt>
                    <dd className="min-w-0">
                      {source.entity ? (
                        <ExplanationEntityLink
                          entity={source.entity.entityKind}
                          id={source.entity.entityId}
                        />
                      ) : null}
                      {source.value !== null || source.entity === null ? (
                        <ReadableExplanationValue value={source.value} />
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
              {result.data.truncated ? (
                <p className="text-muted-foreground">
                  Showing the first sources.
                </p>
              ) : null}
            </section>
          ) : null}
          <ExplanationFooter
            entity={entity}
            id={id}
            field={field}
            surface={surface}
            data={result.data}
            isSubject={subjectAction}
          />
        </>
      )}
    </div>
  );
}

/** Actions first, the rule's prose last and folded: the facts above already
 * say what happened, the rule is there for when they don't. */
function ExplanationFooter({
  entity,
  id,
  field,
  surface,
  data,
  isSubject,
}: {
  entity: Entity;
  id: string;
  field: string;
  surface: FieldExplanationProps["surface"];
  data: FieldExplanationOutput;
  isSubject: (target: { entityKind: Entity; entityId: string }) => boolean;
}) {
  const inheritOwner = useActionMutation({
    mutationFn: inventory.setOwnership.mutationOptions,
    success: "Using inherited owner",
  });
  const confirmOwner = useActionMutation({
    mutationFn: inventory.confirmOwnership.mutationOptions,
    success: "Owner confirmed",
  });
  const resolution = data.resolution;
  const actions = data.actions.flatMap((action) => {
    const inventoryAction = action.target.entityKind === "inventory";
    if (action.kind === "inheritOwner" && inventoryAction) {
      return [
        <Button
          key={action.kind}
          size="xs"
          variant="outline"
          disabled={inheritOwner.isPending}
          onClick={() =>
            inheritOwner.mutate({
              inventoryEntryId: inventoryShortcode.parse(
                action.target.entityId,
              ),
              ownership: { mode: "inherit" },
            })
          }
        >
          {action.label}
        </Button>,
      ];
    }
    if (
      action.kind === "confirmOwner" &&
      inventoryAction &&
      data.evidenceFingerprint
    ) {
      const evidenceFingerprint = data.evidenceFingerprint;
      return [
        <Button
          key={action.kind}
          size="xs"
          variant="outline"
          disabled={confirmOwner.isPending}
          onClick={() =>
            confirmOwner.mutate({
              inventoryEntryId: inventoryShortcode.parse(
                action.target.entityId,
              ),
              evidenceFingerprint,
            })
          }
        >
          {action.label}
        </Button>,
      ];
    }
    // On its own detail page a link back to the subject goes nowhere.
    const self = isSubject(action.target);
    if (self && surface === "detail") return [];
    return [
      <span key={action.kind} className="flex min-w-0 items-center gap-1.5">
        <span className="text-muted-foreground">
          {self ? "Open" : action.label}
        </span>
        <ExplanationEntityLink
          entity={action.target.entityKind}
          id={action.target.entityId}
        />
      </span>,
    ];
  });
  const resets = resolution ? (
    <FieldResolutionEntityActions
      entity={entity}
      id={id}
      field={field}
      resolution={resolution}
    />
  ) : null;
  return (
    <footer className="grid grid-cols-[minmax(0,1fr)] gap-2 border-t border-border pt-2">
      {actions.length > 0 || resolution?.canReset ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {resets}
          {actions}
        </div>
      ) : null}
      <details className="group text-muted-foreground">
        <summary className="cursor-pointer list-none truncate group-open:whitespace-normal [&::-webkit-details-marker]:hidden">
          <span className="font-medium text-foreground">Rule · </span>
          {data.rule.description}
        </summary>
      </details>
    </footer>
  );
}
