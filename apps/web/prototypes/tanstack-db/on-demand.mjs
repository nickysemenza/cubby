// Disposable reproduction: never satisfy a fallback by loading every Task.
import {
  BTreeIndex,
  createCollection,
  createLiveQueryCollection,
} from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import {
  queryCollectionOptions,
  parseLoadSubsetOptions,
} from "@tanstack/query-db-collection";
const requests = [];
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
      if (!limit) throw Error("Refused unbounded fallback");
      return [
        { id: "TSK-AAAA", name: "Synthetic first Task" },
        { id: "TSK-BBBB", name: "Synthetic second Task" },
      ].slice(0, limit);
    },
  }),
);
const list = createLiveQueryCollection((q) =>
  q
    .from({ task: tasks })
    .orderBy(({ task }) => task.id, "asc")
    .limit(2)
    .select(({ task }) => ({ id: task.id, name: task.name })),
);
const subscription = list.subscribeChanges(() => {});
try {
  await list.preload();
  console.log(
    JSON.stringify({
      verdict: "bounded read completed",
      rows: list.toArray,
      requests,
    }),
  );
} catch (error) {
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
  client.clear();
}
