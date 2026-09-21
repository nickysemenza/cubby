import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";

import {
  executeEntityMutationCommand,
  type EntityMutationTransport,
} from "~/entities/entity-mutation-command";
import {
  countPrimaryDeletedReferences,
  entityMutation,
  parseEntityWriteResult,
} from "~/entities/entity-mutation.functions";
import { getAppErrorDetails } from "~/lib/error-utils";

import type { StandardEntity } from "../entity-contracts";
import { entityEditRegistry } from "./definitions";
import type { EntityEditDraft, EntityEditIntent } from "./intent-types";
import {
  buildEntityEdit,
  initialEntityEditValues,
  isResolvedEntityEdit,
  resolveEntityEdit,
} from "./kernel";
import {
  parseEntityEditBulkUpdateInput,
  parseEntityEditCreateInput,
  parseEntityEditUpdateInput,
} from "./mutation-data";
import type {
  EntityActionData,
  EntityActionVariables,
  EditableEntity,
  EntityBulkUpdateOutcome,
  EntityBulkUpdateCommand,
  EntityEditBuildResult,
  EntityEditCommand,
  EntityEditCommandInput,
  EntityEditDraftData,
  EntityEditIssue,
  EntityEditRecord,
  EntityEditResult,
  EntityEditValueSource,
  EntityMutationPort,
  EntityMutationExecution,
  RuntimeEntityEditRequest,
} from "./types";
import { entityEditValueBagSchema } from "./value-schema";

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
function issuesFromRefusal(
  details: ReturnType<typeof getAppErrorDetails>,
): EntityEditIssue[] {
  const issues: EntityEditIssue[] = [
    { message: details.message, source: "server" },
  ];
  for (const issue of details.validationIssues ?? []) {
    const path = issue.path[0] === "data" ? issue.path.slice(1) : issue.path;
    const nextIssue: EntityEditIssue = {
      message: issue.message,
      source: "server",
    };
    if (path.length > 0) nextIssue.field = path.join(".");
    issues.push(nextIssue);
  }
  for (const blocker of details.blockers ?? []) {
    issues.push({
      message: `${blocker.label}: ${blocker.description}`,
      source: "server",
    });
  }
  return issues;
}

const executeMutation = async <E extends EditableEntity>(
  command: EntityEditCommand<E>,
  transport?: EntityMutationTransport,
): Promise<EntityMutationExecution<E>> => {
  const result = await executeEntityMutationCommand(
    command.entity,
    command.operation === "create"
      ? {
          action: command.operation,
          entity: command.entity,
          data: command.data,
        }
      : command.operation === "update"
        ? {
            action: command.operation,
            entity: command.entity,
            id: command.id,
            data: command.data,
          }
        : {
            action: command.operation,
            entity: command.entity,
            ids: [...command.ids],
          },
    transport,
  );
  if (command.operation === "create" || command.operation === "update") {
    if (
      result.action !== command.operation ||
      result.entity !== command.entity ||
      !("item" in result)
    ) {
      throw new Error(
        `${command.entity} ${command.operation} returned ${result.action}.`,
      );
    }
    const item = parseEntityWriteResult(
      command.entity,
      command.operation,
      result,
    );
    return {
      operation: command.operation,
      id: item.id,
      result: item,
    };
  }
  if (result.action !== "delete") {
    throw new Error(`${command.entity} delete returned ${result.action}.`);
  }
  return { operation: command.operation, result };
};

const executeBulkMutation = async <E extends EditableEntity>(
  command: EntityBulkUpdateCommand<E>,
  transport?: EntityMutationTransport,
) => {
  const result = await executeEntityMutationCommand(
    command.entity,
    {
      action: command.operation,
      entity: command.entity,
      ids: [...command.ids],
      data: command.data,
    },
    transport,
  );
  if (result.action !== "bulkUpdate") {
    throw new Error(`${command.entity} bulk update returned ${result.action}.`);
  }
  return result;
};

/** Start adapter for the schema-correlated editing command interface. */
export function createEntityMutationPort(
  transport?: EntityMutationTransport,
): EntityMutationPort {
  return {
    execute: async <E extends EditableEntity>(command: EntityEditCommand<E>) =>
      await executeMutation(command, transport),
    executeBulk: async <E extends EditableEntity>(
      command: EntityBulkUpdateCommand<E>,
    ) => await executeBulkMutation(command, transport),
  };
}

function useEntityMutationPort(): EntityMutationPort {
  return useMemo(() => createEntityMutationPort(), []);
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
    command: EntityEditCommandInput<E>,
  ): Promise<EntityMutationExecution<E>>;
  create(input: {
    values: Readonly<Partial<EntityEditDraft<E>>>;
    intent: EntityEditIntent<E, "create">;
    context?: RuntimeEntityEditRequest<E>["context"];
    surface?: "create-page" | "dialog" | "quick-create";
  }): Promise<EntityEditResult<E>>;
  remove(ids: readonly string[]): Promise<EntityEditResult<E>>;
  executeDeleteAction(
    ids: readonly string[],
  ): Promise<EntityActionData<StandardEntity, "delete">>;
  /** Patch one declared field set across a bounded id set, as `remove` deletes. */
  bulkUpdate(
    ids: readonly string[],
    data: EntityBulkUpdateCommand<E>["data"],
  ): Promise<EntityBulkUpdateOutcome>;
  commitFields(input: {
    record: EntityEditRecord;
    values: EntityEditDraftData<E>;
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

export interface EntityActionCommands<E extends StandardEntity> {
  createAction(
    data: EntityActionVariables<E, "create">,
    intent: string,
  ): Promise<EntityActionData<E, "create">>;
  updateAction(
    variables: EntityActionVariables<E, "update">,
    intent: string,
  ): Promise<EntityActionData<E, "update">>;
  deleteAction(
    variables: EntityActionVariables<E, "delete">,
  ): Promise<EntityActionData<E, "delete">>;
  bulkUpdateAction(
    variables: EntityActionVariables<E, "bulkUpdate">,
  ): Promise<EntityActionData<E, "bulkUpdate">>;
}

export interface EntityCommandsOptions {
  /** A local operation adapter for browser surfaces that cannot reach Start. */
  readonly mutationPort?: EntityMutationPort;
}

/**
 * Canonical command lifecycle for one entity. The hook owns mutation state,
 * invalidation, and background-work re-invalidation; callers only provide a
 * semantic build result or transitional raw payload.
 */
export function useEntityCommands<E extends EditableEntity>(
  entity: E,
  options?: EntityCommandsOptions,
): EntityCommands<E> {
  const productionPort = useEntityMutationPort();
  const port = options?.mutationPort ?? productionPort;
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
    async (command: EntityEditCommandInput<E>) =>
      await executeCommand({ ...command, entity }),
    [entity, executeCommand],
  );

  const executeResult = useCallback(
    async (command: EntityEditCommand<E>): Promise<EntityEditResult<E>> => {
      setIssues([]);
      try {
        const execution = await executeCommand(command);
        if (execution.operation === "delete") {
          const deletedReference = execution.result.deletedReferences.find(
            (reference) => reference.entity === entity,
          );
          if (!deletedReference) {
            throw new Error(`${entity} delete returned no deleted reference.`);
          }
          return {
            ok: true,
            entity,
            id: deletedReference.id,
            changed: true,
          };
        }
        const success = {
          ok: true,
          entity,
          id: execution.id,
          changed: true,
        } satisfies Omit<Extract<EntityEditResult<E>, { ok: true }>, "result">;
        return { ...success, result: execution.result };
      } catch (error) {
        const nextIssues = issuesFromRefusal(getAppErrorDetails(error));
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
          id:
            build.command.operation === "update"
              ? build.command.id
              : build.command.operation === "delete"
                ? (build.command.ids[0] ?? "")
                : "",
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
      }),
    [entity, executeResult],
  );

  const executeDeleteAction = useCallback(
    async (
      ids: readonly string[],
    ): Promise<EntityActionData<StandardEntity, "delete">> => {
      setIssues([]);
      try {
        const execution = await executeCommand({
          entity,
          operation: "delete",
          intent: "delete",
          ids,
        });
        if (execution.operation !== "delete") {
          throw new Error(`${entity} delete returned ${execution.operation}.`);
        }
        return {
          deleted: countPrimaryDeletedReferences(execution.result),
          sideEffects: execution.result.sideEffects,
        };
      } catch (error) {
        const nextIssues = issuesFromRefusal(getAppErrorDetails(error));
        setIssues(nextIssues);
        throw new Error(nextIssues[0]?.message ?? "Delete failed", {
          cause: error,
        });
      }
    },
    [entity, executeCommand],
  );

  const bulkUpdate = useCallback(
    async (
      ids: readonly string[],
      data: EntityBulkUpdateCommand<E>["data"],
    ): Promise<EntityBulkUpdateOutcome> => {
      setIssues([]);
      try {
        const result = await port.executeBulk({
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
          result,
        };
      } catch (error) {
        const nextIssues = issuesFromRefusal(getAppErrorDetails(error));
        setIssues(nextIssues);
        return { ok: false, issues: nextIssues };
      }
    },
    [entity, port],
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
      context?: RuntimeEntityEditRequest<E>["context"];
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

  const commitFieldValues = useCallback(
    async ({
      record,
      values,
      intent,
      surface = "cell",
    }: {
      record: EntityEditRecord;
      values: EntityEditValueSource<E>;
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
      const parsedValues = entityEditValueBagSchema.parse(values);
      const requestedFields = Object.keys(parsedValues);
      const selected = resolved.fields.filter(({ id }) => id in parsedValues);
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
        ...parsedValues,
      };
      return await commit(buildEntityEdit(fieldsResolved, request, nextValues));
    },
    [commit, entity],
  );

  const commitFields = useCallback(
    async (input: {
      record: EntityEditRecord;
      values: EntityEditDraftData<E>;
      intent?: EntityEditIntent<E, "update">;
      surface?: "cell" | "detail" | "preview" | "calendar";
    }) => await commitFieldValues(input),
    [commitFieldValues],
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
      await commitFieldValues({
        ...input,
        values: entityEditValueBagSchema.parse({ [field]: value }),
      }),
    [commitFieldValues],
  );

  return {
    isPending: mutation.isPending,
    issues,
    commit,
    submit,
    create,
    remove,
    executeDeleteAction,
    bulkUpdate,
    commitFields,
    commitField,
  };
}

/** Exact browser-action adapter layered over the semantic editing lifecycle. */
export function useEntityActionCommands<E extends StandardEntity>(
  entity: E,
  options?: EntityCommandsOptions,
): EntityActionCommands<E> {
  const commands = useEntityCommands(entity, options);

  const createAction = useCallback(
    async (
      data: EntityActionVariables<E, "create">,
      intent: string,
    ): Promise<EntityActionData<E, "create">> => {
      const execution = await commands.submit({
        operation: "create",
        intent,
        data: parseEntityEditCreateInput(entity, data),
      });
      if (execution.operation !== "create") {
        throw new Error(`${entity} create returned ${execution.operation}.`);
      }
      return execution.result;
    },
    [commands, entity],
  );

  const updateAction = useCallback(
    async (
      variables: EntityActionVariables<E, "update">,
      intent: string,
    ): Promise<EntityActionData<E, "update">> => {
      const execution = await commands.submit({
        operation: "update",
        intent,
        id: z.string().parse(variables.id),
        data: parseEntityEditUpdateInput(entity, variables.data),
      });
      if (execution.operation !== "update") {
        throw new Error(`${entity} update returned ${execution.operation}.`);
      }
      return execution.result;
    },
    [commands, entity],
  );

  const deleteAction = useCallback(
    async ({ ids }: EntityActionVariables<E, "delete">) => {
      return await commands.executeDeleteAction(ids);
    },
    [commands],
  );

  const bulkUpdateAction = useCallback(
    async (variables: EntityActionVariables<E, "bulkUpdate">) => {
      const ids = z.array(z.string()).parse(variables.ids);
      const data = parseEntityEditBulkUpdateInput(entity, variables.data);
      // SAFETY: `data` is parsed by `entity`'s own bulk-update schema from
      // the editing intent catalog; `commands.bulkUpdate` types its `data`
      // through the wire contract's bulk-update command instead. The entity
      // compiler derives both from the same `capabilities.bulkUpdate.fields`
      // declaration, so they carry the same fields for the same entity —
      // two independently generated types over one runtime shape.
      const result = await commands.bulkUpdate(ids, data as never);
      if (!result.ok) {
        throw new Error(result.issues[0]?.message ?? "Bulk update failed");
      }
      return {
        updated: result.result.updatedReferences.length,
        sideEffects: result.result.sideEffects,
      };
    },
    [commands, entity],
  );

  return { createAction, updateAction, deleteAction, bulkUpdateAction };
}
