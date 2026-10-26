import { entitySchema } from "@cubby/schemas/entity";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import {
  fieldResolutionsSchema,
  type FieldResolution,
} from "@cubby/schemas/field-resolution";
import { getErrorMessage } from "@cubby/shared";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";

import { parseEntityEditUpdateInput } from "~/entity/editing/mutation-data";
import { useEntityCommands } from "~/entity/editing/use-entity-commands";
import { entityDetailLink, isBrowserRoutedEntity } from "~/entity/entities";
import type { StandardEntity } from "~/entity/entity-contracts";
import { generatedBrowserCrudEntities } from "~/entity/generated/entity-routes.gen";
import type { BulkAction } from "~/ui/data-table/bulk-actions.types";
import { Button } from "~/ui/primitives/button";

const resolutionRecordSchema = z.object({
  id: z.string().optional(),
  fieldResolutions: fieldResolutionsSchema.optional(),
});
const resolutionPatchSchema = z.record(z.string(), z.json());
type ResolutionPatch = z.output<typeof resolutionPatchSchema>;

// Not loose: a fixed-shape parse reads only these two keys, while a loose one
// copies every key of the row — and every table cell reads this.
const parseResolutionRecord = (record: unknown) => {
  const parsed = resolutionRecordSchema.safeParse(record);
  return parsed.success ? parsed.data : null;
};

function resolutionEntryIn(
  resolutions: z.output<typeof fieldResolutionsSchema> | undefined,
  field: string,
) {
  if (!resolutions) return null;
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
  const resolutions = parseResolutionRecord(record)?.fieldResolutions;
  if (!resolutions) return null;
  const patch: ResolutionPatch = {};
  for (const [field, resolution] of Object.entries(resolutions)) {
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
  return (
    resolutionEntryIn(parseResolutionRecord(record)?.fieldResolutions, field)
      ?.resolution ?? null
  );
}

/** The manifest's resolution policy for a field, when it declares one. */
export function resolutionPolicyFor(
  entity: string,
  field: string,
): EntityFieldModel["fields"][number]["resolution"] {
  const parsed = entitySchema.safeParse(entity);
  if (!parsed.success) return null;
  return (
    entityFieldModels[parsed.data].fields.find(
      (candidate) => candidate.key === field,
    )?.resolution ?? null
  );
}

/** The shared marker for a value that is inherited, not set here: always
 * visible before the value in its 12px slot. */
export function InheritedMarker({ title }: { title?: string }) {
  return (
    <span
      className="inline-flex w-3 shrink-0 text-muted-foreground"
      title={title ?? "Inherited"}
      data-slot="inherited-marker"
      aria-label="Inherited"
    >
      ↳
    </span>
  );
}

/** Caption actions read as inline text links, not 24px buttons. */
export const resolutionActionClassName =
  "h-auto min-w-0 p-0 text-xs underline decoration-border underline-offset-4 hover:decoration-current";

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
  const pathname = useLocation({ select: (location) => location.pathname });
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
        pathname.endsWith(`/${id}`)
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
