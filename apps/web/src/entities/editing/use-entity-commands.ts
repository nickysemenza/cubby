import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type { z } from "zod";

import {
  entityMutation,
  executeEntityMutation,
  flattenEntityMutationResult,
  parseEntityMutationResultFor,
} from "~/entities/entity-mutation.functions";
import { getAppErrorDetails } from "~/lib/error-utils";
import type { entityBrowserMutationCommandSchema } from "~/server/entity-kernel/contracts";

import { entityEditRegistry } from "./definitions";
import type { EntityEditDraft, EntityEditIntent } from "./intent-types";
import {
  buildEntityEdit,
  initialEntityEditValues,
  isResolvedEntityEdit,
  resolveEntityEdit,
} from "./kernel";
import type {
  EditableEntity,
  EntityBulkUpdateOutcome,
  EntityBulkUpdateResult,
  EntityEditBuildResult,
  EntityEditCommand,
  EntityEditIssue,
  EntityEditRecord,
  EntityEditResult,
  EntityMutationPort,
  RuntimeEntityEditRequest,
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
              : command.operation === "bulkUpdate"
                ? {
                    action: command.operation,
                    entity: command.entity,
                    ids: [...(command.ids ?? (command.id ? [command.id] : []))],
                    data: command.data,
                  }
                : {
                    action: command.operation,
                    entity: command.entity,
                    id: command.id,
                    data: command.data,
                  };
        const result = await executeEntityMutation({
          data: startCommand as z.input<
            typeof entityBrowserMutationCommandSchema
          >,
        });
        if (command.operation === "bulkUpdate") {
          // A bulk patch reports a count over N rows, so there is no single
          // entity output to recover through the entity's own schema.
          return { id: command.ids?.[0] ?? "", result };
        }
        const resultId =
          result && typeof result === "object" && "item" in result
            ? String(result.item.id)
            : (command.id ?? command.ids?.[0]);
        if (!resultId) {
          throw new Error(
            `${command.entity} ${command.operation} did not return an id.`,
          );
        }
        return {
          id: resultId,
          result: parseEntityMutationResultFor(
            command.entity,
            flattenEntityMutationResult(result),
          ),
        };
      },
    }),
    [],
  );
}

/**
 * One descriptor per entity, built once: `forEntity` rebuilds the descriptor and
 * re-registers its invalidation policy on every call, and this runs per render.
 */
const kernelOptionsByEntity = new Map<string, object>();
const kernelOptionsFor = (entity: string) => {
  const cached = kernelOptionsByEntity.get(entity);
  if (cached) return cached;
  const options = entityMutation.mutate.forEntity(entity).mutationOptions();
  kernelOptionsByEntity.set(entity, options);
  return options;
};

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
  /** Patch one declared field set across a bounded id set, as `remove` deletes. */
  bulkUpdate(
    ids: readonly string[],
    data: Readonly<object>,
  ): Promise<EntityBulkUpdateOutcome>;
  commitFields(input: {
    record: EntityEditRecord;
    values: Readonly<Partial<EntityEditDraft<E>>>;
    intent?: EntityEditIntent<E, "update">;
    surface?: "cell" | "detail" | "preview" | "calendar";
  }): Promise<EntityEditResult<E>>;
  /** Generic transport adapter after the entity/payload correlation is erased. */
  commitRuntimeFields(input: {
    record: EntityEditRecord;
    values: Readonly<object>;
    intent?: string;
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
  const [issues, setIssues] = useState<readonly EntityEditIssue[]>([]);
  // Spreading the descriptor's options is what carries `meta` — and with it the
  // operation id the root MutationCache resolves the fan-out from. The kernel
  // descriptor's policy reads the COMMAND's `entity`, which is exactly what
  // this mutation is given, so invalidation (and the background-batch re-poll
  // that used to live on `port.watchBackgroundWork`) happen there, once, for
  // every write in the app rather than per call site.
  const mutation = useMutation({
    ...kernelOptionsFor(entity),
    mutationFn: async (command: EntityEditCommand<E>) =>
      await port.execute(command),
  });

  const executeCommand = useCallback(
    async (command: EntityEditCommand<E>) =>
      await mutation.mutateAsync(command),
    [mutation],
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
          result: parseEntityMutationResultFor(entity, execution.result),
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

  const bulkUpdate = useCallback(
    async (
      ids: readonly string[],
      data: Readonly<object>,
    ): Promise<EntityBulkUpdateOutcome> => {
      setIssues([]);
      try {
        const execution = await executeCommand({
          entity,
          operation: "bulkUpdate",
          intent: "bulkUpdate",
          ids,
          data,
        });
        // The count envelope is deliberately not parsed as an entity output,
        // but it IS the result — a caller's success callback reads `updated`
        // and `sideEffects` off it, and dropping it here resolved every one
        // of them with `undefined`.
        return {
          ok: true,
          entity,
          result: execution.result as EntityBulkUpdateResult,
        };
      } catch (error) {
        const nextIssues = issuesFromRefusal(error);
        setIssues(nextIssues);
        return { ok: false, issues: nextIssues };
      }
    },
    [entity, executeCommand],
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
      const request: RuntimeEntityEditRequest<E> = {
        entity,
        operation: "create",
        intent,
        surface,
        context,
      };
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
      values: Readonly<object>;
      intent?: string;
      surface?: "cell" | "detail" | "preview" | "calendar";
    }): Promise<EntityEditResult<E>> => {
      const request: RuntimeEntityEditRequest<E> = {
        entity,
        operation: "update",
        intent,
        surface,
        record,
      };
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
        values: { [field]: value },
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
    bulkUpdate,
    commitFields,
    commitRuntimeFields: commitFields,
    commitField,
  };
}
