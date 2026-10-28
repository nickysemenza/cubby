import { entitySchema } from "@cubby/schemas/entity";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import {
  fieldEnvelopeFor,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import { fieldAssignmentActions } from "@cubby/schemas/field-envelope-presentation";
import { getErrorMessage } from "@cubby/shared";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { isEqual } from "es-toolkit";
import { useMemo, useState } from "react";
import { z } from "zod";

import { parseEntityEditUpdateInput } from "~/entity/editing/mutation-data";
import { useEntityCommands } from "~/entity/editing/use-entity-commands";
import { entityDetailLink, isBrowserRoutedEntity } from "~/entity/entities";
import type { StandardEntity } from "~/entity/entity-contracts";
import { generatedBrowserCrudEntities } from "~/entity/generated/entity-routes.gen";
import { entityMetadata } from "~/entity/metadata";
import { fieldEnvelopeAtPath } from "~/entity/read-path";
import { fieldExplanation } from "~/integrations/tanstack-query/generated/catalog/fieldExplanation.gen";
import type { BulkAction } from "~/ui/data-table/bulk-actions.types";
import { Button } from "~/ui/primitives/button";

const resolutionPatchSchema = z.record(z.string(), z.json());
type ResolutionPatch = z.output<typeof resolutionPatchSchema>;

function redundantResetCandidates(
  queryClient: QueryClient,
  entity: StandardEntity,
  record: unknown,
) {
  return entityMetadata(queryClient, entity).fields.fields.filter((field) => {
    const envelope = fieldEnvelopeFor(record, field.readKey ?? field.key);
    return (
      field.resolution?.redundancy === "eligible" &&
      envelope?.current.assignment?.kind === "value" &&
      envelope.current.controls.kind === "editable" &&
      envelope.current.controls.reset.kind === "available"
    );
  });
}

function redundantResetPatch(
  envelope: ReadableFieldEnvelope,
  reset: ResolutionPatch,
): ResolutionPatch | null {
  const { assignment, controls } = envelope.current;
  if (
    assignment?.kind !== "value" ||
    controls.kind !== "editable" ||
    controls.reset.kind !== "available" ||
    controls.reset.preview.kind !== "ready"
  )
    return null;
  const preview = controls.reset.preview.result.decision.outcome;
  return preview.kind === "value" && isEqual(assignment.value, preview.value)
    ? reset
    : null;
}

/** Permanent list action for removing redundant explicit values in one or many
 * selected rows through the ordinary generated update mutation. */
export function useRedundantOverrideBulkAction<TData extends { id: string }>(
  entity: StandardEntity | undefined,
): BulkAction<TData> | null {
  const commands = useEntityCommands(entity ?? "product");
  const queryClient = useQueryClient();
  return useMemo(() => {
    if (
      !entity ||
      !entityMetadata(queryClient, entity).fields.fields.some(
        (field) => field.resolution?.redundancy === "eligible",
      )
    )
      return null;
    return {
      id: "use-inherited-values",
      label: "Use inherited values",
      icon: <ArrowCounterClockwiseIcon />,
      availability: (rows) =>
        rows.some(
          (row) =>
            redundantResetCandidates(queryClient, entity, row.original).length,
        )
          ? { status: "available" }
          : { status: "hidden" },
      onExecute: async (rows) => {
        const outcomes = await Promise.all(
          rows.map(async (row) => {
            const patch: ResolutionPatch = {};
            // Lists carry current eligibility; exact equality is checked only on execution.
            const previews = await Promise.all(
              redundantResetCandidates(queryClient, entity, row.original).map(
                async (field) => ({
                  field,
                  explanation: await queryClient.fetchQuery({
                    ...fieldExplanation.explain.queryOptions({
                      entityKind: entity,
                      entityId: row.original.id,
                      field: field.key,
                      surface: "detail",
                    }),
                    staleTime: 0,
                  }),
                }),
              ),
            );
            for (const { field, explanation } of previews) {
              if (!field.resolution) continue;
              const reset = redundantResetPatch(
                explanation.envelope,
                resolutionPatchSchema.parse(field.resolution.reset),
              );
              if (reset) Object.assign(patch, reset);
            }
            if (!Object.keys(patch).length) return false;
            await commands.submit({
              operation: "update",
              intent: "full",
              id: row.original.id,
              data: await parseEntityEditUpdateInput(entity, patch),
            });
            return true;
          }),
        );
        return { success: outcomes.some(Boolean) };
      },
    };
  }, [commands, entity, queryClient]);
}

export function fieldResolutionFor(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The canonical field parser owns this generic row boundary.
  record: unknown,
  field: string,
  path?: string,
): ReadableFieldEnvelope | null {
  return (
    fieldEnvelopeFor(record, field) ??
    fieldEnvelopeFor(record, `${field}Id`) ??
    (path ? fieldEnvelopeAtPath(record, path) : undefined) ??
    null
  );
}

/** The manifest's resolution policy for a field, when it declares one. */
export function resolutionPolicyFor(
  queryClient: QueryClient,
  entity: string,
  field: string,
): EntityFieldModel["fields"][number]["resolution"] {
  const parsed = entitySchema.safeParse(entity);
  if (!parsed.success) return null;
  return (
    entityMetadata(queryClient, parsed.data).fields.fields.find(
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
  resolution: ReadableFieldEnvelope;
}) {
  const queryClient = useQueryClient();
  const entity = generatedBrowserCrudEntities.find(
    (candidate) => candidate === candidateEntity,
  );
  if (!entity) return null;
  const policy = resolutionPolicyFor(queryClient, entity, field);
  const actions = fieldAssignmentActions(resolution, policy, field).map(
    (action) => ({
      ...action,
      patch: resolutionPatchSchema.parse(action.patch),
    }),
  );
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
        data: await parseEntityEditUpdateInput(entity, patch),
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
