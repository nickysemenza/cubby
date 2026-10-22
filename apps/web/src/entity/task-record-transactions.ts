import { taskOut, taskUpdateData } from "@cubby/schemas/project";
import { createCollection, createTransaction } from "@tanstack/db";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { z } from "zod";

import type { EditableEntity, EntityEditCommand } from "./editing/types";

type TaskIdentity = Pick<z.input<typeof taskOut>, "id">;
type TaskRename = Required<Pick<z.infer<typeof taskUpdateData>, "name">>;
type TaskChange =
  | { kind: "rename"; taskId: TaskIdentity["id"]; patch: TaskRename }
  | { kind: "delete"; taskId: TaskIdentity["id"] };
type PendingTaskChange = TaskChange & { sequence: number };

const renameSchema = taskUpdateData.pick({ name: true }).required().strict();
const emptyChanges: readonly PendingTaskChange[] = [];
const getEmptySnapshot = () => emptyChanges;
const emptySubscribe = () => () => {};

function createTaskRecordStore() {
  const collection = createCollection<PendingTaskChange>({
    getKey: (change) => change.sequence,
    startSync: true,
    sync: {
      // Query owns canonical records. This source never persists overlay rows.
      sync: ({ markReady }) => markReady(),
    },
  });
  let sequence = 0;
  let snapshot = emptyChanges;
  const listeners = new Set<() => void>();
  collection.subscribeChanges(() => {
    snapshot = Array.from(collection.values()).sort(
      (left, right) => left.sequence - right.sequence,
    );
    for (const listener of listeners) listener();
  });
  return {
    collection,
    nextSequence: () => ++sequence,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const stores = new WeakMap<
  QueryClient,
  ReturnType<typeof createTaskRecordStore>
>();
function getTaskRecordStore(client: QueryClient) {
  let store = stores.get(client);
  if (!store) {
    store = createTaskRecordStore();
    stores.set(client, store);
  }
  return store;
}

export async function runTaskRecordTransaction<E extends EditableEntity, R>(
  client: QueryClient,
  command: EntityEditCommand<E>,
  execute: () => Promise<R>,
): Promise<R> {
  if (typeof window === "undefined" || command.entity !== "task") {
    return await execute();
  }
  const changes: TaskChange[] = [];
  if (command.operation === "delete") {
    for (const taskId of new Set(command.ids)) {
      changes.push({ kind: "delete", taskId });
    }
  } else if (command.operation === "update") {
    const parsed = renameSchema.safeParse(command.data);
    if (parsed.success && typeof parsed.data.name === "string") {
      changes.push({ kind: "rename", taskId: command.id, patch: parsed.data });
    }
  }
  if (changes.length === 0) return await execute();

  const store = getTaskRecordStore(client);
  let outcome: { value: R } | undefined;
  const transaction = createTransaction({
    mutationFn: async () => {
      // mutateAsync includes the root MutationCache's awaited invalidation.
      outcome = { value: await execute() };
    },
  });
  transaction.mutate(() => {
    for (const change of changes) {
      store.collection.insert({ ...change, sequence: store.nextSequence() });
    }
  });
  // Settlement drops the optimistic inserts; rejection rolls them back.
  await transaction.isPersisted.promise;
  if (!outcome) throw new Error("Task transaction completed without a result.");
  return outcome.value;
}

export function useTaskRecordProjector(entity: string) {
  const client = useQueryClient();
  // Server renders never create or retain a transaction store.
  const store =
    typeof window !== "undefined" && entity === "task"
      ? getTaskRecordStore(client)
      : undefined;
  const changes = useSyncExternalStore(
    store?.subscribe ?? emptySubscribe,
    store?.getSnapshot ?? getEmptySnapshot,
    getEmptySnapshot,
  );
  return useCallback(
    <T extends { id: string }>(rows: readonly T[]): T[] => {
      const projected: T[] = [];
      for (const row of rows) {
        let current = row;
        let deleted = false;
        for (const change of changes) {
          if (change.taskId !== row.id) continue;
          if (change.kind === "delete") deleted = true;
          else current = { ...current, ...change.patch };
        }
        if (!deleted) projected.push(current);
      }
      return projected;
    },
    [changes],
  );
}

export function useTaskRecordProjection<T extends { id: string }>(
  entity: string,
  rows: readonly T[],
): T[] {
  const project = useTaskRecordProjector(entity);
  return useMemo(() => project(rows), [project, rows]);
}
