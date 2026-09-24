import {
  dashboardLocalCounts,
  type DashboardLocalCounts,
} from "@cubby/schemas/dashboard";
import type { ProblemsCount } from "@cubby/schemas/problems";
import { problemsCountSchema } from "@cubby/schemas/problems";
import superjson from "superjson";
import type { z } from "zod";

import {
  getDatabaseFreshnessNamespace,
  getExecutionCtx,
  getWorkerVersionId,
} from "~/server/cf-env";

import type { DatabaseFreshness } from "./state";

const DATABASE_FRESHNESS_RPC_TIMEOUT_MS = 1000;
// Only the authenticated workflow reads this internal cache. Keep the TTL short:
// DO refreshes can publish in another data center without an edge-wide purge.
const PROBLEM_COUNTS_EDGE_TTL_SECONDS = 10;
const PROBLEM_COUNTS_EDGE_KEY = "/__internal/cache/problem-counts-v1";

interface EdgeCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
}

interface EdgeCacheStorage extends CacheStorage {
  default: EdgeCache;
}

const hasDefaultCache = (
  storage: CacheStorage | undefined,
): storage is EdgeCacheStorage => storage !== undefined && "default" in storage;

const problemCountsEdgeCache = (): { cache: EdgeCache; key: string } | null => {
  const origin = getExecutionCtx()?.origin;
  const storage = globalThis.caches;
  if (!origin || !hasDefaultCache(storage)) return null;
  return {
    cache: storage.default,
    key: new URL(PROBLEM_COUNTS_EDGE_KEY, origin).toString(),
  };
};
export interface DatabaseFreshnessPort {
  readFreshness(): Promise<DatabaseFreshness>;
  recordWrite(): Promise<DatabaseFreshness>;
}

export interface ProblemCountsSnapshotPort {
  getProblemCounts(): Promise<ProblemsCount>;
}

export interface ReadSnapshotPort {
  getDashboardCounts(): Promise<DashboardLocalCounts | null>;
}

export interface ListSnapshotPort {
  getListSnapshot(
    key: string,
  ): Promise<{ payload: string | null; revision: number }>;
  putListSnapshot(
    key: string,
    payload: string,
    revision: number,
  ): Promise<void>;
}

const getPort = () =>
  getDatabaseFreshnessNamespace()?.getByName("household", {
    locationHint: "wnam",
  });

async function boundedRpc<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Database freshness RPC timed out")),
          DATABASE_FRESHNESS_RPC_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readDatabaseFreshness(
  port?: DatabaseFreshnessPort,
): Promise<DatabaseFreshness | null> {
  try {
    const target = port ?? getPort();
    if (!target) return null;
    return await boundedRpc(() => target.readFreshness());
  } catch (error) {
    console.warn("Database freshness lookup failed; using strong reads", error);
    return null;
  }
}

export async function recordDatabaseWrite(
  source: string,
  port?: DatabaseFreshnessPort,
): Promise<void> {
  try {
    const target = port ?? getPort();
    if (!target) {
      console.warn("Database freshness notification unavailable", { source });
      return;
    }
    await boundedRpc(() => target.recordWrite());
  } catch (error) {
    console.warn("Database freshness notification failed", { source, error });
  }
}

export async function readProblemCountsFromDurableObject(
  port?: ProblemCountsSnapshotPort,
): Promise<ProblemsCount | null> {
  const edge = problemCountsEdgeCache();
  if (edge) {
    try {
      const hit = await edge.cache.match(edge.key);
      if (hit) {
        const parsed = problemsCountSchema.safeParse(await hit.json());
        if (parsed.success) return parsed.data;
      }
    } catch (error) {
      // SILENT: a cache lookup failure falls back to the durable snapshot.
      console.warn("Problem-count edge cache lookup failed", error);
    }
  }
  const target = port ?? getPort();
  if (!target) return null;
  try {
    // A cold snapshot runs the detector pass, so it must not inherit the
    // one-second latency bound used by the tiny freshness RPCs.
    const counts = problemsCountSchema.parse(await target.getProblemCounts());
    if (edge) {
      const write = edge.cache
        .put(
          edge.key,
          new Response(JSON.stringify(counts), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": `public, max-age=${PROBLEM_COUNTS_EDGE_TTL_SECONDS}`,
            },
          }),
        )
        .catch((error) => {
          // SILENT: a cache write cannot fail an otherwise successful read.
          console.warn("Problem-count edge cache write failed", error);
        });
      const execution = getExecutionCtx();
      if (execution) execution.waitUntil(write);
      else await write;
    }
    return counts;
  } catch (error) {
    console.error("Problem-count snapshot RPC failed", error);
    throw error;
  }
}

export async function readDashboardCountsSnapshot(
  port?: Pick<ReadSnapshotPort, "getDashboardCounts">,
): Promise<DashboardLocalCounts | null> {
  const target = port ?? getPort();
  if (!target) return null;
  try {
    const snapshot = await target.getDashboardCounts();
    return snapshot ? dashboardLocalCounts.parse(snapshot) : null;
  } catch (error) {
    console.error("Dashboard-count snapshot unavailable", error);
    return null;
  }
}

export async function readEntityListSnapshot<
  Input extends z.ZodType,
  Output extends z.ZodType,
>(
  input: z.output<Input>,
  output: Output,
  port?: ListSnapshotPort,
): Promise<{
  data: z.output<Output> | null;
  key: string;
  revision: number | null;
}> {
  // SAFETY: DB_FRESHNESS binds DatabaseFreshnessDurableObject, whose RPC
  // methods implement ListSnapshotPort.
  const target: ListSnapshotPort | undefined =
    port ?? (getPort() as ListSnapshotPort | undefined);
  if (!target) return { data: null, key: "", revision: null };
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(superjson.stringify(input)),
    );
    const key = `entity-list:${getWorkerVersionId()}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const snapshot = await boundedRpc(() => target.getListSnapshot(key));
    if (snapshot.payload === null) {
      return { data: null, key, revision: snapshot.revision };
    }
    const parsed = output.safeParse(superjson.parse(snapshot.payload));
    return {
      data: parsed.success ? parsed.data : null,
      key,
      revision: snapshot.revision,
    };
  } catch (error) {
    // SILENT: a cache failure falls back to the authoritative list read.
    console.warn("Entity list snapshot lookup failed", error);
    return { data: null, key: "", revision: null };
  }
}

export function publishEntityListSnapshot<Data>(
  key: string,
  revision: number | null,
  data: Data,
  port?: ListSnapshotPort,
): void {
  // SAFETY: DB_FRESHNESS binds DatabaseFreshnessDurableObject, whose RPC
  // methods implement ListSnapshotPort.
  const target: ListSnapshotPort | undefined =
    port ?? (getPort() as ListSnapshotPort | undefined);
  if (!target || revision === null) return;
  try {
    const publish = target
      .putListSnapshot(key, superjson.stringify(data), revision)
      .catch((error) => {
        // SILENT: a cache publish failure cannot fail a validated list read.
        console.warn("Entity list snapshot publish failed", error);
      });
    const execution = getExecutionCtx();
    if (execution) execution.waitUntil(publish);
    else void publish;
  } catch (error) {
    // SILENT: a cache publish failure cannot fail a validated list read.
    console.warn("Entity list snapshot publish failed", error);
  }
}
