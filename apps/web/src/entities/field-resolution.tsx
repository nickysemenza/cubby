import { auditEntitySchema } from "@cubby/schemas/audit";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
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
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { parseEntityEditUpdateInput } from "~/entities/editing/mutation-data";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import type { StandardEntity } from "~/entities/entity-contracts";
import { generatedBrowserCrudEntities } from "~/entities/generated/entity-routes.gen";
import { getErrorMessage } from "~/lib/error-utils";

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
    <span className="inline-flex flex-wrap items-center gap-1">
      {resolution.canReset && redundancy === "eligible" ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation();
            void submit({ ...reset });
          }}
        >
          Use inherited value
        </Button>
      ) : null}
      {resolution.mode === "inherit" && none ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation();
            void submit({ ...none });
          }}
        >
          None
        </Button>
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
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
    const Icon = redundant
      ? TriangleAlert
      : resolution.mode === "inherit"
        ? CornerDownRight
        : resolution.mode === "allocated"
          ? PieChart
          : resolution.mode === "none"
            ? CircleSlash
            : RotateCcw;
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
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      <Badge
        variant={redundant ? "warning" : "secondary"}
        title={`${resolutionLabel(resolution)} · effective value from ${resolution.source}`}
      >
        {redundant ? (
          <TriangleAlert aria-hidden="true" />
        ) : resolution.mode === "inherit" ? (
          <CornerDownRight aria-hidden="true" />
        ) : resolution.canReset ? (
          <RotateCcw aria-hidden="true" />
        ) : null}
        {resolutionLabel(resolution)}
      </Badge>
      {resolution.sourceEntity && sourceEntity?.success ? (
        <EntityInlineLinkById
          entityType={sourceEntity.data}
          entityId={resolution.sourceEntity.entityId}
        />
      ) : null}
      {action}
    </span>
  );
}
