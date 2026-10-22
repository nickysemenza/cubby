// Disposable reproduction: never satisfy a fallback by loading every Task.
import {
  BTreeIndex,
  createCollection,
  createLiveQueryCollection,
  eq,
  gt,
} from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import {
  queryCollectionOptions,
  parseLoadSubsetOptions,
} from "@tanstack/query-db-collection";
const requests = [];
const join = process.argv.includes("--join");
const after = process.argv.find((arg) => arg.startsWith("--after="))?.slice(8);
const localeOrder = process.argv.includes("--locale");
const offset = Number(
  process.argv.find((arg) => arg.startsWith("--offset="))?.split("=")[1] ?? 0,
);
const fixture = Array.from({ length: 50 }, (_, index) => ({
  id: `TSK-SYNTHETIC-${String(index).padStart(2, "0")}`,
  name: `Synthetic Task ${index}`,
  projectId: "PRJ-SYNTHETIC",
}));
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity } },
});
const tasks = createCollection(
  queryCollectionOptions({
    id: "bounded-reproduction",
    queryClient: client,
    queryKey: ["bounded-reproduction"],
    syncMode: "on-demand",
    getKey: (row) => row.id,
    autoIndex: "eager",
    defaultIndexType: BTreeIndex,
    queryFn: async (ctx) => {
      const { limit, filters } = parseLoadSubsetOptions(
        ctx.meta?.loadSubsetOptions,
      );
      requests.push({ limit, filters });
      const exactId = filters.find(
        (f) => f.field.at(-1) === "id" && f.operator === "eq",
      );
      if (!limit && !exactId) throw Error("Refused unbounded fallback");
      const rows = fixture.filter((row) =>
        filters.every((filter) => {
          if (filter.field.at(-1) !== "id")
            throw Error("Unsupported predicate field");
          if (filter.operator === "eq") return row.id === filter.value;
          if (filter.operator === "gt") return row.id > filter.value;
          throw Error("Unsupported predicate operator");
        }),
      );
      const pageOffset = ctx.meta?.loadSubsetOptions?.offset ?? 0;
      const result = rows.slice(
        pageOffset,
        limit ? pageOffset + limit : undefined,
      );
      requests.at(-1).offset = pageOffset;
      requests.at(-1).returned = result.length;
      return result;
    },
  }),
);
const projects = createCollection(
  queryCollectionOptions({
    autoIndex: "eager",
    defaultIndexType: BTreeIndex,
    id: "bounded-projects",
    queryClient: client,
    queryKey: ["bounded-projects"],
    getKey: (row) => row.id,
    queryFn: async () => [{ id: "PRJ-SYNTHETIC", name: "Sample project" }],
  }),
);
const list = createLiveQueryCollection((q) => {
  let query = q.from({ task: tasks });
  if (after) query = query.where(({ task }) => gt(task.id, after));
  if (join)
    query = query.leftJoin({ project: projects }, ({ task, project }) =>
      eq(task.projectId, project.id),
    );
  return query
    .orderBy(({ task }) => task.id, {
      direction: "asc",
      stringSort: localeOrder ? "locale" : "lexical",
    })
    .limit(2)
    .offset(offset)
    .select(({ task, project }) => ({
      id: task.id,
      name: task.name,
      ...(join ? { project: project?.name } : {}),
    }));
});
const subscription = list.subscribeChanges(() => {});
try {
  await list.preload();
  console.log(
    JSON.stringify({
      verdict: "bounded read completed",
      rows: list.toArray.map(({ id, name, project }) => ({
        id,
        name,
        project,
      })),
      loaded: tasks.size,
      server: fixture.length,
      requests,
    }),
  );
} catch (error) {
  process.exitCode = 1;
  console.log(
    JSON.stringify({
      verdict: "bounded-loading guard refused the reproduction",
      error: error.message,
      requests,
    }),
  );
} finally {
  subscription.unsubscribe();
  await list.cleanup();
  await tasks.cleanup();
  await projects.cleanup();
  client.clear();
}
