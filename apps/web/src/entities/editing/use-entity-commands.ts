import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTRPC } from "~/integrations/trpc/react";
import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidate,
} from "~/lib/background-batch-polling";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidateTRPCQueries } from "~/lib/query-keys";
import { getEntityContract } from "../entity-contracts";
import { entityEditRegistry } from "./definitions";
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

type MutationOptions = {
  mutationFn?: (variables: unknown) => Promise<unknown>;
};

/**
 * Client adapter for the common command port. It is deliberately the only
 * dynamic tRPC dispatch point; semantic definitions never import hooks.
 */
function useEntityMutationPort(): EntityMutationPort {
  const api = useTRPC();
  const queryClient = useQueryClient();

  return useMemo(
    () => ({
      execute: async (command) => {
        const contract = getEntityContract(command.entity);
        const operation =
          command.operation === "delete"
            ? contract.mutation.delete
            : contract.mutation[command.operation];
        if (!operation) {
          throw new Error(
            `${command.entity} does not expose ${command.operation}.`,
          );
        }
        const options = operation(api, {} as never) as MutationOptions;
        if (!options.mutationFn) {
          throw new Error(
            `${command.entity} has no executable ${command.operation} mutation.`,
          );
        }
        const variables =
          command.operation === "create"
            ? command.data
            : command.operation === "delete"
              ? { ids: command.ids ?? (command.id ? [command.id] : []) }
              : { id: command.id, data: command.data };
        const result = await options.mutationFn(variables);
        const resultId =
          result && typeof result === "object" && "id" in result
            ? String(result.id)
            : (command.id ?? command.ids?.[0]);
        if (!resultId) {
          throw new Error(
            `${command.entity} ${command.operation} did not return an id.`,
          );
        }
        return { id: resultId, result };
      },
      invalidate: async (keys) => {
        invalidateTRPCQueries(queryClient, keys);
      },
      watchBackgroundWork: ({ result, invalidateKeys }) => {
        void watchBatchesAndInvalidate({
          queryClient,
          result,
          invalidateKeys,
          fetchBatchStatus: makeBatchStatusFetcher(queryClient, api),
        });
      },
    }),
    [api, queryClient],
  );
}

export interface EntityCommands<E extends EditableEntity> {
  readonly isPending: boolean;
  readonly issues: readonly EntityEditIssue[];
  /** Execute a semantic command already built by an entity definition. */
  commit(build: EntityEditBuildResult<E>): Promise<EntityEditResult<E>>;
  /** Same lifecycle as `raw`, but preserves mutation rejection for legacy callers. */
  executeOrThrow(
    command: EntityEditCommand<E>,
  ): Promise<{ id: string; result: unknown }>;
  /** Compatibility escape hatch while older forms migrate to semantic fields. */
  raw(command: EntityEditCommand<E>): Promise<EntityEditResult<E>>;
  update(input: {
    id: string;
    data: object;
    intent?: string;
  }): Promise<EntityEditResult<E>>;
  remove(ids: readonly string[], intent?: string): Promise<EntityEditResult<E>>;
  commitField(input: {
    record: EntityEditRecord;
    field: string;
    value: unknown;
    intent?: string;
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

  const executeOrThrow = useCallback(
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

  const raw = useCallback(
    async (command: EntityEditCommand<E>): Promise<EntityEditResult<E>> => {
      setIssues([]);
      try {
        const execution = await executeOrThrow(command);
        return {
          ok: true,
          entity,
          id: execution.id,
          changed: true,
          result: execution.result,
        };
      } catch (error) {
        const nextIssues = [
          { message: getErrorMessage(error), source: "server" as const },
        ];
        setIssues(nextIssues);
        return { ok: false, issues: nextIssues };
      }
    },
    [entity, executeOrThrow],
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
      return await raw(build.command);
    },
    [entity, raw],
  );

  const update = useCallback(
    async ({
      id,
      data,
      intent = "legacy",
    }: {
      id: string;
      data: object;
      intent?: string;
    }) =>
      await raw({
        entity,
        operation: "update",
        intent,
        id,
        data,
      }),
    [entity, raw],
  );

  const remove = useCallback(
    async (ids: readonly string[], intent = "legacy") =>
      await raw({
        entity,
        operation: "delete",
        intent,
        ids,
        data: {},
      }),
    [entity, raw],
  );

  const commitField = useCallback(
    async ({
      record,
      field: fieldId,
      value,
      intent,
      surface = "cell",
    }: {
      record: EntityEditRecord;
      field: string;
      value: unknown;
      intent?: string;
      surface?: "cell" | "detail" | "preview" | "calendar";
    }): Promise<EntityEditResult<E>> => {
      const request: EntityEditRequest<E> = {
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
      const selected = resolved.fields.find(({ id }) => id === fieldId);
      if (!selected) {
        const nextIssues = [
          {
            field: fieldId,
            message: `${entity}'s ${surface} surface does not expose ${fieldId}.`,
            source: "client" as const,
          },
        ];
        setIssues(nextIssues);
        return { ok: false, issues: nextIssues };
      }
      const fieldResolved = { ...resolved, fields: [selected] };
      const values = {
        ...initialEntityEditValues(fieldResolved, request),
        [fieldId]: value,
      };
      return await commit(buildEntityEdit(fieldResolved, request, values));
    },
    [commit, entity],
  );

  return {
    isPending: mutation.isPending,
    issues,
    commit,
    executeOrThrow,
    raw,
    update,
    remove,
    commitField,
  };
}
