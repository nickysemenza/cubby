// PROTOTYPE: real TanStack DB, synthetic persistence, no production callers.
import {
  BTreeIndex,
  createCollection,
  createLiveQueryCollection,
  eq,
} from "@tanstack/db";
import { dehydrate, hydrate, QueryClient } from "@tanstack/query-core";
import {
  parseLoadSubsetOptions,
  queryCollectionOptions,
} from "@tanstack/query-db-collection";
import { z } from "zod";

const taskSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
  revision: z.number(),
});
const projectSchema = z.object({ id: z.string(), name: z.string() });
const A = "TSK-AAAA";
const B = "TSK-BBBB";
export { A, B };

export async function createPrototype(
  changed = () => {},
  { onDemand = false, hydratedState } = {},
) {
  const server = new Map(
    Array.from({ length: 50 }, (_, index) => {
      const id =
        index === 0
          ? A
          : index === 1
            ? B
            : `TSK-SYNTHETIC-${String(index).padStart(2, "0")}`;
      return [
        id,
        taskSchema.parse({
          id,
          name:
            index === 0
              ? "Inspect sample filter"
              : index === 1
                ? "Replace sample seal"
                : `Synthetic task ${index}`,
          projectId: index % 2 ? "PRJ-BBBB" : "PRJ-AAAA",
          revision: 0,
        }),
      ];
    }),
  );
  const requests = [];
  const pending = [];
  const outcomes = [];
  let nextWrite = 1;
  let active = true;
  const notify = () => {
    if (active) changed();
  };
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
      },
    },
  });
  if (hydratedState) hydrate(client, hydratedState);
  const persist = (kind, mutations) =>
    new Promise((resolve, reject) => {
      pending.push({ id: nextWrite++, kind, mutations, resolve, reject });
      notify();
    });
  const tasks = createCollection(
    queryCollectionOptions({
      id: "prototype-tasks",
      schema: taskSchema,
      getKey: (task) => task.id,
      autoIndex: "eager",
      defaultIndexType: BTreeIndex,
      queryClient: client,
      syncMode: onDemand ? "on-demand" : "eager",
      queryKey: ["prototype", "tasks"],
      queryFn: async (ctx) => {
        const subset = ctx.meta?.loadSubsetOptions;
        const parsed = parseLoadSubsetOptions(subset);
        const { filters, sorts } = parsed;
        const limit = onDemand ? parsed.limit : 2;
        if (
          !limit &&
          !filters.some(
            (f) => f.field.at(-1) === "id" && ["eq", "in"].includes(f.operator),
          )
        )
          throw Error("Prototype refuses an unbounded Task read");
        let rows = [...server.values()];
        for (const filter of filters) {
          const field = filter.field.at(-1);
          if (
            !["id", "projectId"].includes(field) ||
            !["eq", "in"].includes(filter.operator)
          )
            throw Error("Unsupported server predicate");
          rows = rows.filter((row) =>
            filter.operator === "eq"
              ? row[field] === filter.value
              : filter.value.includes(row[field]),
          );
        }
        if (
          sorts.some(
            (sort) => sort.field.at(-1) !== "id" || sort.direction !== "asc",
          )
        )
          throw Error("Unsupported server sort");
        rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const offset = subset?.offset ?? 0;
        const total = rows.length;
        rows = rows
          .slice(offset, limit ? offset + limit : undefined)
          .map((row) => taskSchema.parse(row));
        requests.push({
          filters,
          limit,
          offset,
          total,
          returned: rows.length,
          bytes: new TextEncoder().encode(JSON.stringify(rows)).length,
        });
        notify();
        return rows;
      },
      onUpdate: async ({ transaction, collection }) => {
        const receipts = await persist(
          "update",
          transaction.mutations.map((m) => ({ id: m.key, changes: m.changes })),
        );
        await collection.utils.writeUpdate(receipts);
        return { refetch: false };
      },
      onDelete: async ({ transaction, collection }) => {
        const ids = transaction.mutations.map((m) => m.key);
        await persist("delete", ids);
        await collection.utils.writeDelete(ids);
        return { refetch: false };
      },
    }),
  );
  const projects = createCollection(
    queryCollectionOptions({
      id: "prototype-projects",
      schema: projectSchema,
      getKey: (project) => project.id,
      autoIndex: "eager",
      defaultIndexType: BTreeIndex,
      queryClient: client,
      queryKey: ["prototype", "projects", "two-explicit-ids"],
      queryFn: async () => [
        { id: "PRJ-AAAA", name: "Sample upkeep" },
        { id: "PRJ-BBBB", name: "Sample repairs" },
      ],
    }),
  );
  const list = createLiveQueryCollection((q) =>
    q
      .from({ task: tasks })
      .orderBy(({ task }) => task.id, {
        direction: "asc",
        stringSort: "lexical",
      })
      .limit(2)
      .select(({ task }) => ({ ...task })),
  );
  const detail = createLiveQueryCollection((q) =>
    q
      .from({ task: tasks })
      .where(({ task }) => eq(task.id, A))
      .select(({ task }) => ({ ...task })),
  );
  // This join describes ONLY the bounded loaded page, not complete Project membership.
  const related = createLiveQueryCollection((q) =>
    q
      .from({ task: tasks })
      .leftJoin({ project: projects }, ({ task, project }) =>
        eq(task.projectId, project.id),
      )
      .orderBy(({ task }) => task.id, {
        direction: "asc",
        stringSort: "lexical",
      })
      .limit(2)
      .select(({ task, project }) => ({
        id: task.id,
        name: task.name,
        project: project?.name,
        projectId: task.projectId,
      })),
  );
  const subscriptions = [list, detail, related].map((c) =>
    c.subscribeChanges(notify),
  );
  await Promise.all([list.preload(), detail.preload(), related.preload()]);
  const observe = (tx) => {
    void tx.isPersisted.promise.then(
      () => {
        outcomes.push("Write accepted");
        notify();
      },
      (error) => {
        outcomes.push(error.message);
        notify();
      },
    );
    return tx.id;
  };
  return {
    rename: (id, name) =>
      observe(
        tasks.update(id, (draft) => {
          draft.name = name;
        }),
      ),
    move: () =>
      observe(
        tasks.update(A, (draft) => {
          draft.projectId = "PRJ-BBBB";
        }),
      ),
    remove: () => observe(tasks.delete(A)),
    settle: (id, accept) => {
      const index = pending.findIndex((write) => write.id === id);
      if (index < 0) throw Error("No pending write");
      const [write] = pending.splice(index, 1);
      if (!accept) {
        write.reject(
          new Error(
            "Synthetic write refused: SQLSTATE 23514; constraint sample_task_name",
          ),
        );
        notify();
        return;
      }
      if (write.kind === "delete") {
        for (const key of write.mutations) server.delete(key);
        write.resolve([]);
      } else {
        const receipts = write.mutations.map(({ id, changes }) => {
          const previous = server.get(id);
          if (!previous) throw Error("Synthetic Task missing");
          const row = taskSchema.parse({
            ...previous,
            ...changes,
            name: (changes.name ?? previous.name).trim(),
            revision: previous.revision + 1,
          });
          server.set(id, row);
          return row;
        });
        write.resolve(receipts);
      }
      notify();
    },
    background: () => {
      const row = server.get(B);
      server.set(B, {
        ...row,
        name: "Changed by synthetic background job",
        revision: row.revision + 1,
      });
      notify();
    },
    refresh: async () => {
      await tasks.utils.refetch();
      notify();
    },
    dehydrate: () => dehydrate(client),
    snapshot: () => ({
      list: list.toArray.map((row) => taskSchema.parse(row)),
      detail: detail.toArray.map((row) => taskSchema.parse(row)),
      related: related.toArray.map(({ id, name, project, projectId }) => ({
        id,
        name,
        project,
        projectId,
      })),
      server: [...server.values()].slice(0, 3),
      serverCount: server.size,
      loadedCount: tasks.size,
      requests: structuredClone(requests),
      pending: pending.map(({ id, kind, mutations }) => ({
        id,
        kind,
        mutations,
      })),
      outcomes: [...outcomes],
    }),
    dispose: async () => {
      active = false;
      subscriptions.forEach((s) => s.unsubscribe());
      await Promise.all([related.cleanup(), detail.cleanup(), list.cleanup()]);
      await tasks.cleanup();
      await projects.cleanup();
      client.clear();
    },
  };
}
