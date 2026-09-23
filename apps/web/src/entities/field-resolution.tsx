import { auditEntitySchema } from "@cubby/schemas/audit";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  fieldResolutionsSchema,
  type FieldResolution,
} from "@cubby/schemas/field-resolution";
import { parseShortcode } from "@cubby/shared";
import {
  CircleSlash,
  CornerDownRight,
  PieChart,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import type { BulkAction } from "~/app/_components/data-table/bulk-actions.types";
import { EntityInlineLinkById } from "~/app/_components/EntityInlineLinkById";
import { Button } from "~/components/ui/button";
import { parseEntityEditUpdateInput } from "~/entities/editing/mutation-data";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import type { StandardEntity } from "~/entities/entity-contracts";
import { generatedBrowserCrudEntities } from "~/entities/generated/entity-routes.gen";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";

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
      icon: <RotateCcw />,
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

function resolutionLabel(resolution: FieldResolution): string {
  switch (resolution.mode) {
    case "inherit":
      return resolution.source;
    case "none":
      return "Explicitly none";
    case "allocated":
      return resolution.source;
    case "explicit":
      return resolution.matchesFallback
        ? "Matches inherited value"
        : "Override";
  }
}

function resolutionIcon(resolution: FieldResolution) {
  if (resolution.mode === "explicit" && resolution.matchesFallback)
    return TriangleAlert;
  switch (resolution.mode) {
    case "inherit":
      return CornerDownRight;
    case "allocated":
      return PieChart;
    case "none":
      return CircleSlash;
    case "explicit":
      return RotateCcw;
  }
}

/** The caption's lead-in: where the value comes from, read left to right into
 * the source link ("From project [Garden]"). */
function resolutionPhrase(resolution: FieldResolution): string {
  switch (resolution.mode) {
    case "inherit":
      return resolution.sourceEntity
        ? `From ${resolution.sourceEntity.entityType === "task" ? "parent task" : entitySummary[resolution.sourceEntity.entityType].singular.toLowerCase()}`
        : sentenceCase(resolution.source);
    case "allocated":
      return "Allocated from";
    case "none":
      return "Set to none here";
    case "explicit":
      return resolution.matchesFallback
        ? "Same as inherited value"
        : "Set here";
  }
}

const sentenceCase = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

/** Caption actions read as inline text links, not 24px buttons. */
export const resolutionActionClassName = "h-auto p-0 text-xs";

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
  if (!entry || !resolutionIsInformative(entry.resolution)) return null;
  return (
    <FieldResolutionStatus
      compact={compact}
      resolution={entry.resolution}
      action={
        action ??
        (interactive ? (
          <FieldResolutionActions
            record={record}
            field={entry.field}
            resolution={entry.resolution}
          />
        ) : null)
      }
    />
  );
}

function FieldResolutionActions({
  record,
  field,
  resolution,
}: {
  record: unknown;
  field: string;
  resolution: FieldResolution;
}) {
  const recordResult = resolutionRecordSchema.safeParse(record);
  const parsedRecord = recordResult.success
    ? parseShortcode(recordResult.data.id ?? "")
    : null;
  const entity = generatedBrowserCrudEntities.find(
    (candidate) => candidate === parsedRecord?.type,
  );
  if (!entity || !parsedRecord) return null;
  const policy = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === field,
  )?.resolution;
  if (!policy) return null;
  return (
    <BoundFieldResolutionActions
      entity={entity}
      id={parsedRecord.shortcode}
      resolution={resolution}
      reset={resolutionPatchSchema.parse(policy.reset)}
      none={
        policy.none === null ? null : resolutionPatchSchema.parse(policy.none)
      }
      redundancy={policy.redundancy}
    />
  );
}

function BoundFieldResolutionActions({
  entity,
  id,
  resolution,
  reset,
  none,
  redundancy,
}: {
  entity: StandardEntity;
  id: string;
  resolution: FieldResolution;
  reset: ResolutionPatch;
  none: ResolutionPatch | null;
  redundancy: "eligible" | "intentional";
}) {
  const commands = useEntityCommands(entity);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (patch: ResolutionPatch) => {
    setPending(true);
    setError(null);
    try {
      await commands.submit({
        operation: "update",
        intent: "full",
        id,
        data: parseEntityEditUpdateInput(entity, patch),
      });
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {resolution.canReset &&
      redundancy === "eligible" &&
      resolution.fallbackValue !== null ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className={resolutionActionClassName}
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation();
            void submit({ ...reset });
          }}
        >
          Use inherited value
        </Button>
      ) : null}
      {resolution.mode === "inherit" && resolution.value !== null && none ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className={resolutionActionClassName}
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation();
            void submit({ ...none });
          }}
        >
          Set to none
        </Button>
      ) : null}
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
}: {
  resolution: FieldResolution;
  action?: ReactNode;
  compact?: boolean;
}) {
  const redundant =
    resolution.mode === "explicit" && resolution.matchesFallback;
  const sourceEntity = resolution.sourceEntity
    ? auditEntitySchema.safeParse(resolution.sourceEntity.entityType)
    : null;
  if (compact) {
    const Icon = resolutionIcon(resolution);
    return (
      <span
        className="inline-flex shrink-0 text-muted-foreground"
        title={resolutionLabel(resolution)}
      >
        <Icon className="size-3.5" aria-hidden="true" />
        <span className="sr-only">{resolutionLabel(resolution)}</span>
      </span>
    );
  }
  if (!resolutionIsInformative(resolution)) return action ?? null;
  const Icon = resolutionIcon(resolution);
  return (
    <span
      data-slot="field-resolution"
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted-foreground [&>[data-slot=button]]:ms-1",
        redundant && "text-warning-ink",
      )}
      title={`Effective value from ${resolution.source}`}
    >
      <span className="inline-flex shrink-0 items-center gap-1">
        <Icon aria-hidden="true" className="size-3 shrink-0" />
        {resolutionPhrase(resolution)}
      </span>
      {(resolution.mode === "inherit" || resolution.mode === "allocated") &&
      resolution.sourceEntity &&
      sourceEntity?.success ? (
        // Its own flex item: a long source name wraps to a full line
        // before it truncates.
        <span className="flex max-w-full min-w-0">
          <EntityInlineLinkById
            entityType={sourceEntity.data}
            entityId={resolution.sourceEntity.entityId}
          />
        </span>
      ) : null}
      {action}
    </span>
  );
}
