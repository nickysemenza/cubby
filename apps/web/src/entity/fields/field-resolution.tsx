import { auditEntitySchema } from "@cubby/schemas/audit";
import { entitySchema } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  fieldResolutionsSchema,
  type FieldResolution,
} from "@cubby/schemas/field-resolution";
import { capitalize, parseShortcode, getErrorMessage } from "@cubby/shared";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ChartPieIcon } from "@phosphor-icons/react/dist/csr/ChartPie";
import { DotOutlineIcon } from "@phosphor-icons/react/dist/csr/DotOutline";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { ProhibitIcon } from "@phosphor-icons/react/dist/csr/Prohibit";
import { TreeViewIcon } from "@phosphor-icons/react/dist/csr/TreeView";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import type { Icon } from "@phosphor-icons/react/lib";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { parseEntityEditUpdateInput } from "~/entity/editing/mutation-data";
import { useEntityCommands } from "~/entity/editing/use-entity-commands";
import { entityDetailLink, isBrowserRoutedEntity } from "~/entity/entities";
import type { StandardEntity } from "~/entity/entity-contracts";
import { generatedBrowserCrudEntities } from "~/entity/generated/entity-routes.gen";
import { cn } from "~/lib/utils";
import type { BulkAction } from "~/ui/data-table/bulk-actions.types";
import { Button } from "~/ui/primitives/button";

const resolutionRecordSchema = z.looseObject({
  id: z.string().optional(),
  fieldResolutions: fieldResolutionsSchema.optional(),
});
const resolutionPatchSchema = z.record(z.string(), z.json());
type ResolutionPatch = z.output<typeof resolutionPatchSchema>;

function fieldResolutionEntryFor(record: unknown, field: string) {
  const parsedRecord = resolutionRecordSchema.safeParse(record);
  if (!parsedRecord.success || !parsedRecord.data.fieldResolutions) return null;
  const resolutions = parsedRecord.data.fieldResolutions;
  const key =
    [field, `${field}Id`].find((candidate) => resolutions[candidate]) ??
    Object.keys(resolutions).find(
      (candidate) =>
        candidate.endsWith("Id") && candidate.slice(0, -2) === field,
    );
  return key ? { field: key, resolution: resolutions[key]! } : null;
}

function redundantResetPatch(
  entity: StandardEntity,
  record: unknown,
): ResolutionPatch | null {
  const parsedRecord = resolutionRecordSchema.safeParse(record);
  if (!parsedRecord.success || !parsedRecord.data.fieldResolutions) return null;
  const patch: ResolutionPatch = {};
  for (const [field, resolution] of Object.entries(
    parsedRecord.data.fieldResolutions,
  )) {
    if (
      resolution.mode !== "explicit" ||
      !resolution.matchesFallback ||
      !resolution.canReset
    )
      continue;
    const policy = entityFieldModels[entity].fields.find(
      (candidate) => candidate.key === field,
    )?.resolution;
    if (policy?.redundancy === "eligible") Object.assign(patch, policy.reset);
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Permanent list action for removing redundant explicit values in one or many
 * selected rows through the ordinary generated update mutation. */
export function useRedundantOverrideBulkAction<TData extends { id: string }>(
  entity: StandardEntity | undefined,
): BulkAction<TData> | null {
  const commands = useEntityCommands(entity ?? "product");
  return useMemo(() => {
    if (
      !entity ||
      !entityFieldModels[entity].fields.some(
        (field) => field.resolution?.redundancy === "eligible",
      )
    )
      return null;
    return {
      id: "use-inherited-values",
      label: "Use inherited values",
      icon: <ArrowCounterClockwiseIcon />,
      availability: (rows) =>
        rows.some((row) => redundantResetPatch(entity, row.original))
          ? { status: "available" }
          : { status: "hidden" },
      onExecute: async (rows) => {
        const outcomes = await Promise.all(
          rows.flatMap((row) => {
            const patch = redundantResetPatch(entity, row.original);
            return patch
              ? [
                  commands.submit({
                    operation: "update",
                    intent: "full",
                    id: row.original.id,
                    data: parseEntityEditUpdateInput(entity, patch),
                  }),
                ]
              : [];
          }),
        );
        return { success: outcomes.length > 0 };
      },
    };
  }, [commands, entity]);
}

export function fieldResolutionFor(
  record: unknown,
  field: string,
): FieldResolution | null {
  const parsedRecord = resolutionRecordSchema.safeParse(record);
  if (!parsedRecord.success || !parsedRecord.data.fieldResolutions) return null;
  return fieldResolutionEntryFor(parsedRecord.data, field)?.resolution ?? null;
}

/** Whether a resolution tells the reader anything the value doesn't. An empty
 * inherited value already reads as `—`, and an explicit value with nothing to
 * inherit is simply the value — marking either as "Unassigned"/"Override" was
 * noise, and offering to reset the latter would only clear it. */
export function resolutionIsInformative(resolution: FieldResolution): boolean {
  switch (resolution.mode) {
    case "inherit":
      return resolution.value !== null;
    case "explicit":
      return resolution.matchesFallback || resolution.fallbackValue !== null;
    case "none":
      return resolution.fallbackValue !== null;
    case "allocated":
      return true;
  }
}

/** A value this record takes from elsewhere rather than stores itself. Table
 * cells read it muted, so derived and stored values differ without a rail. */
export const resolutionIsDerived = (resolution: FieldResolution) =>
  resolutionIsInherited(resolution) || resolution.mode === "allocated";

/** Inherited and not confirmed or set here: the values the marker flags. */
export const resolutionIsInherited = (resolution: FieldResolution) =>
  resolution.mode === "inherit" && resolution.value !== null;

/** The manifest's resolution policy for a field, when it declares one. */
export function resolutionPolicyFor(entity: string, field: string) {
  const parsed = entitySchema.safeParse(entity);
  if (!parsed.success) return null;
  return (
    entityFieldModels[parsed.data].fields.find(
      (candidate) => candidate.key === field,
    )?.resolution ?? null
  );
}

/** The shared marker for a value that is inherited, not set here: always
 * visible after the muted value in list cells, beside it on detail pages. */
export function InheritedMarker({ title }: { title?: string }) {
  return (
    <span
      className="inline-flex shrink-0 text-muted-foreground"
      title={title ?? "Inherited"}
      data-slot="inherited-marker"
    >
      <TreeViewIcon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">Inherited</span>
    </span>
  );
}

export type ResolutionTone =
  | "set"
  | "override"
  | "redundant"
  | "none"
  | "inherit"
  | "allocated";

/** One vocabulary for the caption, the rail icon, and the explanation
 * popover. An explicit value with nothing above it is "Set here", never an
 * override: there is nothing for it to override. */
export type ResolutionState = {
  tone: ResolutionTone;
  label: string;
  Icon: Icon;
};

export function resolutionState(
  resolution: FieldResolution,
  { intentional = false }: { intentional?: boolean } = {},
): ResolutionState {
  switch (resolution.mode) {
    case "inherit":
      return { tone: "inherit", label: "Inherited", Icon: TreeViewIcon };
    case "allocated":
      return {
        tone: "allocated",
        label: capitalize(resolution.source),
        Icon: ChartPieIcon,
      };
    case "none":
      return { tone: "none", label: "None", Icon: ProhibitIcon };
    case "explicit":
      // A field that offers Confirm pins a matching value on purpose.
      if (resolution.matchesFallback && !intentional)
        return { tone: "redundant", label: "Redundant", Icon: WarningIcon };
      return resolution.fallbackValue === null || resolution.matchesFallback
        ? { tone: "set", label: "Set here", Icon: DotOutlineIcon }
        : {
            tone: "override",
            label: "Set here",
            Icon: ArrowCounterClockwiseIcon,
          };
  }
}

/** The caption's lead-in: where the value comes from, read left to right into
 * the source link ("From project [Garden]"). */
function resolutionPhrase(
  resolution: FieldResolution,
  intentional: boolean,
): string {
  switch (resolution.mode) {
    case "inherit":
      return resolution.sourceEntity
        ? `From ${resolution.sourceEntity.entityKind === "task" ? "parent task" : entitySummary[resolution.sourceEntity.entityKind].singular.toLowerCase()}`
        : capitalize(resolution.source);
    case "allocated":
      return resolution.sourceEntity
        ? "Allocated from"
        : capitalize(resolution.source);
    case "none":
      return "None";
    case "explicit":
      return resolution.matchesFallback && !intentional
        ? "Same as inherited value"
        : "Set here";
  }
}

/** Caption actions read as inline text links, not 24px buttons. */
export const resolutionActionClassName =
  "h-auto min-w-0 p-0 text-xs underline decoration-border underline-offset-4 hover:decoration-current";

function recordRef(record: unknown) {
  const parsed = resolutionRecordSchema.safeParse(record);
  return parsed.success ? parseShortcode(parsed.data.id ?? "") : null;
}

/** Compact provenance for values whose stored assignment differs from the
 * effective value shown in forms and tables. */
export function FieldResolutionBadge({
  record,
  field,
  action,
  interactive = true,
  compact = false,
}: {
  record: unknown;
  field: string;
  action?: ReactNode;
  interactive?: boolean;
  compact?: boolean;
}) {
  const entry = fieldResolutionEntryFor(record, field);
  if (!entry) return null;
  const ref = recordRef(record);
  const intentional =
    ref !== null &&
    resolutionPolicyFor(ref.type, entry.field)?.redundancy === "intentional";
  const actions =
    interactive && ref ? (
      <FieldResolutionEntityActions
        entity={ref.type}
        id={ref.shortcode}
        field={entry.field}
        resolution={entry.resolution}
      />
    ) : null;
  // Nothing to explain, but an action may still apply (Unknown → Household).
  if (!resolutionIsInformative(entry.resolution)) return actions;
  return (
    <FieldResolutionStatus
      compact={compact}
      intentional={intentional}
      resolution={entry.resolution}
      action={action ?? actions}
    />
  );
}

/** Use inherited / set to none / confirm links for a record addressed by
 * entity and shortcode (the explanation popover has no row record). */
export function FieldResolutionEntityActions({
  entity: candidateEntity,
  id,
  field,
  resolution,
}: {
  entity: string;
  id: string;
  field: string;
  resolution: FieldResolution;
}) {
  const entity = generatedBrowserCrudEntities.find(
    (candidate) => candidate === candidateEntity,
  );
  if (!entity) return null;
  const policy = resolutionPolicyFor(entity, field);
  if (!policy) return null;
  const actions: Array<{ label: string; patch: ResolutionPatch }> = [];
  if (resolution.canReset)
    actions.push({
      label:
        resolution.fallbackValue === null && !policy.labels?.unresolved
          ? "Clear value"
          : "Use inherited",
      patch: resolutionPatchSchema.parse(policy.reset),
    });
  if (
    policy.confirm &&
    resolution.mode === "inherit" &&
    resolution.value !== null
  )
    actions.push({
      label: "Confirm",
      patch: {
        ...resolutionPatchSchema.parse(policy.confirm),
        [field]: resolution.value,
      },
    });
  if (
    policy.none &&
    resolution.mode === "inherit" &&
    (resolution.value !== null || policy.labels?.none)
  )
    actions.push({
      label: `Set to ${policy.labels?.none ?? "none"}`,
      patch: resolutionPatchSchema.parse(policy.none),
    });
  if (actions.length === 0) return null;
  return (
    <BoundFieldResolutionActions entity={entity} id={id} actions={actions} />
  );
}

function BoundFieldResolutionActions({
  entity,
  id,
  actions,
}: {
  entity: StandardEntity;
  id: string;
  actions: ReadonlyArray<{ label: string; patch: ResolutionPatch }>;
}) {
  const commands = useEntityCommands(entity);
  const navigate = useNavigate();
  const location = useLocation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (patch: ResolutionPatch) => {
    setPending(true);
    setError(null);
    try {
      const execution = await commands.submit({
        operation: "update",
        intent: "full",
        id,
        data: parseEntityEditUpdateInput(entity, patch),
      });
      // An ownership change can fold the record into the one already in its
      // slot; a detail page then follows the survivor.
      const survivor = "id" in execution ? execution.id : undefined;
      if (
        survivor &&
        survivor !== id &&
        isBrowserRoutedEntity(entity) &&
        location.pathname.endsWith(`/${id}`)
      )
        await navigate(entityDetailLink(entity, survivor));
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {actions.map((action) => (
        <Button
          key={action.label}
          type="button"
          variant="link"
          size="xs"
          className={resolutionActionClassName}
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation();
            void submit({ ...action.patch });
          }}
        >
          {action.label}
        </Button>
      ))}
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </>
  );
}

export function FieldResolutionStatus({
  resolution,
  action,
  compact = false,
  intentional = false,
}: {
  resolution: FieldResolution;
  action?: ReactNode;
  compact?: boolean;
  intentional?: boolean;
}) {
  const redundant =
    resolution.mode === "explicit" &&
    resolution.matchesFallback &&
    !intentional;
  const sourceEntity = resolution.sourceEntity
    ? auditEntitySchema.safeParse(resolution.sourceEntity.entityKind)
    : null;
  if (compact) {
    // A bare value (set here, or inheriting nothing) gets the neutral info
    // glyph; a provenance glyph would claim a relationship that isn't there.
    const state = resolutionIsInformative(resolution)
      ? resolutionState(resolution, { intentional })
      : { label: "Details", Icon: InfoIcon };
    const { Icon } = state;
    // An inherited value announces where it comes from, not just "Inherited".
    const label =
      resolution.mode === "inherit" ? resolution.source : state.label;
    return (
      <span
        className="inline-flex shrink-0 text-muted-foreground"
        title={`${label} · ${resolution.sourceEntity?.name ?? resolution.source}`}
      >
        <Icon className="size-3.5" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  if (!resolutionIsInformative(resolution)) return action ?? null;
  const { Icon } = resolutionState(resolution, { intentional });
  return (
    <span
      data-slot="field-resolution"
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground [&>[data-slot=button]]:ms-1",
        redundant && "text-warning-ink",
      )}
      title={`Effective value from ${resolution.source}`}
    >
      <span className="inline-flex shrink-0 items-center gap-1">
        <Icon aria-hidden="true" className="size-3 shrink-0" />
        {resolutionPhrase(resolution, intentional)}
      </span>
      {(resolution.mode === "inherit" || resolution.mode === "allocated") &&
      resolution.sourceEntity &&
      sourceEntity?.success ? (
        // Its own flex item: a long source name wraps to a full line
        // before it truncates.
        <span className="flex max-w-full min-w-0">
          <EntityRefLink
            variant="byId"
            entityKind={sourceEntity.data}
            entityId={resolution.sourceEntity.entityId}
            name={resolution.sourceEntity.name}
          />
        </span>
      ) : null}
      {action}
    </span>
  );
}
