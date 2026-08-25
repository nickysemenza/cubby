import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
  executeEntityMutation,
  flattenEntityMutationResult,
} from "~/entities/entity-mutation.functions";
import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidate,
} from "~/lib/background-batch-polling";
import { getAppErrorDetails } from "~/lib/error-utils";
import { invalidateQueryRoots } from "~/lib/query-keys";
import { entityEditRegistry } from "./definitions";
import type {
  EntityEditDraft,
  EntityEditIntent,
  EntityEditResultFor,
} from "./intent-types";
import {
  buildEntityEdit,
  initialEntityEditValues,
  isResolvedEntityEdit,
  resolveEntityEdit,
} from "./kernel";
import { getEntityEditDefinition } from "./registry";
import type {
  EditableEntity,
  EntityEditBuildResult,
  EntityEditCommand,
  EntityEditIssue,
  EntityEditRecord,
  EntityEditRequest,
  EntityEditResult,
  EntityMutationPort,
} from "./types";

/**
 * A Start refusal already says which field failed and what lifecycle edge
 * blocked it; collapsing that to `error.message` threw both away, so a form
 * could only ever show one flattened sentence and never mark the control at
 * fault. The headline stays first and field-less, because the dialog banner
 * and the delete dialog both read the first field-less issue as the summary.
 *
 * The server path is the operation input's path (`data.name`), while form
 * fields are named without that envelope.
 */
function issuesFromRefusal(error: unknown): EntityEditIssue[] {
  const details = getAppErrorDetails(error);
  const issues: EntityEditIssue[] = [
    { message: details.message, source: "server" },
  ];
  for (const issue of details.validationIssues ?? []) {
    const path = issue.path[0] === "data" ? issue.path.slice(1) : issue.path;
    issues.push({
      ...(path.length > 0 ? { field: path.join(".") } : {}),
      message: issue.message,
      source: "server",
    });
  }
  for (const blocker of details.blockers ?? []) {
    issues.push({
      message: `${blocker.label}: ${blocker.description}`,
      source: "server",
    });
  }
  return issues;
}

/**
 * Client adapter for the common command port. Semantic definitions stay
 * transport-neutral while this adapter maps them to the Start command shape.
 */
function useEntityMutationPort(): EntityMutationPort {
  const queryClient = useQueryClient();

  return useMemo(
    () => ({
      execute: async (command) => {
        const startCommand =
          command.operation === "create"
            ? {
                action: command.operation,
                entity: command.entity,
                data: command.data,
              }
            : command.operation === "delete"
              ? {
                  action: command.operation,
                  entity: command.entity,
                  ids: [...(command.ids ?? (command.id ? [command.id] : []))],
                }
              : {
                  action: command.operation,
                  entity: command.entity,
                  id: command.id,
                  data: command.data,
                };
        const result = await executeEntityMutation({
          data: startCommand as never,
        });
        const resultId =
          result && typeof result === "object" && "item" in result
            ? String(result.item.id)
            : (command.id ?? command.ids?.[0]);
        if (!resultId) {
          throw new Error(
            `${command.entity} ${command.operation} did not return an id.`,
          );
        }
        return { id: resultId, result: flattenEntityMutationResult(result) };
      },
      invalidate: async (keys) => {
        invalidateQueryRoots(queryClient, keys);
      },
      watchBackgroundWork: ({ result, invalidateKeys }) => {
        void watchBatchesAndInvalidate({
          queryClient,
          result,
          invalidateKeys,
          fetchBatchStatus: makeBatchStatusFetcher(queryClient),
        });
      },
    }),
    [queryClient],
  );
}

export interface EntityCommands<E extends EditableEntity> {
  readonly isPending: boolean;
  readonly issues: readonly EntityEditIssue[];
  /** Execute a semantic command already built by an entity definition. */
  commit(build: EntityEditBuildResult<E>): Promise<EntityEditResult<E>>;
  /** Submit a complete payload from a rich form adapter. Semantic field forms
   * should prefer `commit`; this interface exists for Recipe/Inventory/media-rich forms. */
  submit(
    command: Omit<EntityEditCommand<E>, "entity">,
  ): Promise<{ id: string; result: unknown }>;
  create(input: {
    values: Readonly<Partial<EntityEditDraft<E>>>;
    intent: EntityEditIntent<E, "create">;
    context?: Readonly<Record<string, unknown>>;
    surface?: "create-page" | "dialog" | "quick-create";
  }): Promise<EntityEditResult<E>>;
  remove(ids: readonly string[]): Promise<EntityEditResult<E>>;
  commitFields(input: {
    record: EntityEditRecord;
    values: Readonly<Partial<EntityEditDraft<E>>>;
    intent?: EntityEditIntent<E, "update">;
    surface?: "cell" | "detail" | "preview" | "calendar";
  }): Promise<EntityEditResult<E>>;
  commitField(input: {
    record: EntityEditRecord;
    field: Extract<keyof EntityEditDraft<E>, string>;
    value: EntityEditDraft<E>[Extract<keyof EntityEditDraft<E>, string>];
    intent?: EntityEditIntent<E, "update">;
    surface?: "cell" | "detail" | "preview" | "calendar";
  }): Promise<EntityEditResult<E>>;
}

/**
 * Canonical command lifecycle for one entity. The hook owns mutation state,
 * invalidation, and background-work re-invalidation; callers only provide a
 * semantic build result or transitional raw payload.
 */
export function useEntityCommands<E extends EditableEntity>(
  entity: E,
): EntityCommands<E> {
  const port = useEntityMutationPort();
  const definition = getEntityEditDefinition(entityEditRegistry, entity);
  const [issues, setIssues] = useState<readonly EntityEditIssue[]>([]);
  const mutation = useMutation({
    mutationFn: async (command: EntityEditCommand<E>) =>
      await port.execute(command),
  });

  const executeCommand = useCallback(
    async (command: EntityEditCommand<E>) => {
      const execution = await mutation.mutateAsync(command);
      await port.invalidate(definition.invalidationKeys);
      port.watchBackgroundWork?.({
        result: execution.result,
        invalidateKeys: definition.invalidationKeys,
      });
      return execution;
    },
    [definition.invalidationKeys, mutation, port],
  );

  const submit = useCallback(
    async (command: Omit<EntityEditCommand<E>, "entity">) =>
      await executeCommand({ ...command, entity }),
    [entity, executeCommand],
  );

  const executeResult = useCallback(
    async (command: EntityEditCommand<E>): Promise<EntityEditResult<E>> => {
      setIssues([]);
      try {
        const execution = await executeCommand(command);
        return {
          ok: true,
          entity,
          id: execution.id,
          changed: true,
          result: execution.result as EntityEditResultFor<E>,
        };
      } catch (error) {
        const nextIssues = issuesFromRefusal(error);
        setIssues(nextIssues);
        return { ok: false, issues: nextIssues };
      }
    },
    [entity, executeCommand],
  );

  const commit = useCallback(
    async (build: EntityEditBuildResult<E>): Promise<EntityEditResult<E>> => {
      if (!build.ok) {
        setIssues(build.issues);
        return build;
      }
      if (!build.changed) {
        setIssues([]);
        return {
          ok: true,
          entity,
          id: build.command.id ?? "",
          changed: false,
        };
      }
      return await executeResult(build.command);
    },
    [entity, executeResult],
  );

  const remove = useCallback(
    async (ids: readonly string[]) =>
      await executeResult({
        entity,
        operation: "delete",
        intent: "delete",
        ids,
        data: {},
      }),
    [entity, executeResult],
  );

  const create = useCallback(
    async ({
      values,
      intent,
      context,
      surface = "dialog",
    }: {
      values: Readonly<Partial<EntityEditDraft<E>>>;
      intent: EntityEditIntent<E, "create">;
      context?: Readonly<Record<string, unknown>>;
      surface?: "create-page" | "dialog" | "quick-create";
    }): Promise<EntityEditResult<E>> => {
      const request = {
        entity,
        operation: "create",
        intent,
        surface,
        context,
      } as EntityEditRequest<E>;
      const resolved = resolveEntityEdit(entityEditRegistry, request);
      if (!isResolvedEntityEdit(resolved)) {
        setIssues(resolved.issues);
        return { ok: false, issues: resolved.issues };
      }
      return await commit(
        buildEntityEdit(resolved, request, {
          ...initialEntityEditValues(resolved, request),
          ...values,
        }),
      );
    },
    [commit, entity],
  );

  const commitFields = useCallback(
    async ({
      record,
      values,
      intent,
      surface = "cell",
    }: {
      record: EntityEditRecord;
      values: Readonly<Partial<EntityEditDraft<E>>>;
      intent?: EntityEditIntent<E, "update">;
      surface?: "cell" | "detail" | "preview" | "calendar";
    }): Promise<EntityEditResult<E>> => {
      const request = {
        entity,
        operation: "update",
        intent,
        surface,
        record,
      } as EntityEditRequest<E>;
      const resolved = resolveEntityEdit(entityEditRegistry, request);
      if (!isResolvedEntityEdit(resolved)) {
        setIssues(resolved.issues);
        return { ok: false, issues: resolved.issues };
      }
      const requestedFields = Object.keys(values);
      const selected = resolved.fields.filter(({ id }) => id in values);
      const missing = requestedFields.filter(
        (fieldId) => !selected.some(({ id }) => id === fieldId),
      );
      if (missing.length > 0) {
        const nextIssues = [
          {
            field: missing[0],
            message: `${entity}'s ${resolved.intent} intent does not expose ${missing.join(", ")}.`,
            source: "client" as const,
          },
        ];
        setIssues(nextIssues);
        return { ok: false, issues: nextIssues };
      }
      const fieldsResolved = { ...resolved, fields: selected };
      const nextValues = {
        ...initialEntityEditValues(fieldsResolved, request),
        ...values,
      };
      return await commit(buildEntityEdit(fieldsResolved, request, nextValues));
    },
    [commit, entity],
  );

  const commitField = useCallback(
    async <K extends Extract<keyof EntityEditDraft<E>, string>>({
      field,
      value,
      ...input
    }: {
      record: EntityEditRecord;
      field: K;
      value: EntityEditDraft<E>[K];
      intent?: EntityEditIntent<E, "update">;
      surface?: "cell" | "detail" | "preview" | "calendar";
    }) =>
      await commitFields({
        ...input,
        values: { [field]: value } as unknown as Partial<EntityEditDraft<E>>,
      }),
    [commitFields],
  );

  return {
    isPending: mutation.isPending,
    issues,
    commit,
    submit,
    create,
    remove,
    commitFields,
    commitField,
  };
}
