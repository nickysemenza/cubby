import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";

import { setCfEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { derivedRefreshCursor } from "~/server/db/schema";
import type { DerivedRefreshPorts } from "~/server/generic/derived-refresh/repo/refresh-ports.boundary";

/** Discovery fixtures finish publication using an external embedding-provider stub. */
export async function settleDerivedRefreshForDiscovery(
  db: Database,
): Promise<void> {
  const { processDerivedRefreshPage } =
    await import("~/server/generic/derived-refresh/repo/process");
  const ports: DerivedRefreshPorts = {
    refreshEmbeddings: async (_db, refs) =>
      new Map(
        refs.map((ref) => [
          `${ref.entityKind}:${ref.entityId}`,
          { state: "ready" },
        ]),
      ),
    prepareRecipe: async () => {
      throw new Error("Unexpected Recipe in synthetic discovery fixture");
    },
  };
  for (let page = 0; page < 10_000; page++) {
    const result = await processDerivedRefreshPage(db, ports);
    if (result.errors.length) throw new Error(result.errors.join("\n"));
    if (result.done) return;
  }
  throw new Error("Synthetic discovery publication exceeded its page budget");
}

const frontierDrains = new WeakMap<Database, Promise<void>>();

/** Explicit fixture settlement waits for the offline pump on the same handle. */
export async function drainDerivedRefreshFrontier(
  db: Database,
  maxPages = 10_000,
): Promise<void> {
  const previous = frontierDrains.get(db) ?? Promise.resolve();
  const draining = previous.then(() =>
    advanceDerivedRefreshFrontier(db, maxPages),
  );
  frontierDrains.set(db, draining);
  try {
    await draining;
  } finally {
    if (frontierDrains.get(db) === draining) frontierDrains.delete(db);
  }
}

/** Run the real provider-free frontier when a test needs settled projections. */
async function advanceDerivedRefreshFrontier(
  db: Database,
  maxPages: number,
): Promise<void> {
  const { processDerivedRefreshPage } =
    await import("~/server/generic/derived-refresh/repo/process");
  const ports: DerivedRefreshPorts = {
    prepareRecipe: async () => {
      throw new Error("Provider called during synthetic frontier-only work");
    },
    refreshEmbeddings: async () => {
      throw new Error("Provider called during synthetic frontier-only work");
    },
  };
  let processed = 0;
  for (let page = 0; page < maxPages; page++) {
    const result = await processDerivedRefreshPage(db, ports, {
      frontierOnly: true,
    });
    if (result.errors.length) throw new Error(result.errors.join("\n"));
    if (result.done) return;
    processed += result.processed;
  }
  throw new Error(
    `Synthetic derived frontier exceeded its page budget (${processed} pages advanced)`,
  );
}

/** Exercise the periodic SQL/import backstop without a wall-clock wait. */
export async function reconcileDerivedRefreshInputs(
  db: Database,
): Promise<void> {
  const { reconcileDerivedRefreshPage } =
    await import("~/server/generic/derived-refresh/repo/reconcile");
  await getDb(db)
    .update(derivedRefreshCursor)
    .set({ availableAt: new Date(0) });
  for (let page = 0; page < 2_000; page++) {
    if ((await reconcileDerivedRefreshPage(db)).done) {
      await drainDerivedRefreshFrontier(db);
      return;
    }
  }
  throw new Error("Synthetic input repair exceeded its page budget");
}

/** Capture real envelopes and finish durable work; transport/Run admission has separate integration coverage. */
export function captureBackgroundQueue() {
  const tasks: BackgroundTask[] = [];
  setCfEnv(
    fromPartial<Env>({
      BACKGROUND_QUEUE: {
        sendBatch: async (messages: Iterable<{ body: unknown }>) => {
          for (const { body } of messages) {
            tasks.push(backgroundTaskMessageSchema.parse(body).task);
          }
        },
      },
    }),
  );
  return {
    tasks,
    async drain(
      db: Database,
      options: {
        maxTasks?: number;
        derivedRefreshPorts?: DerivedRefreshPorts;
      } = {},
    ): Promise<number> {
      const maxTasks = options.maxTasks ?? 10_000;
      const { handleBackgroundTask } =
        await import("~/server/workflows/background-tasks/handle");
      let handled = 0;
      while (tasks.length > 0) {
        if (handled >= maxTasks)
          throw new Error(
            `Background queue drain exceeded ${maxTasks} tasks; possible cascade cycle`,
          );
        const task = tasks[0]!;
        if (task.kind === "derived-refresh.wakeup") {
          const { processDerivedRefreshPage } =
            await import("~/server/generic/derived-refresh/repo/process");
          if (!options.derivedRefreshPorts)
            throw new Error(
              "Queue drain requires injected derived refresh ports",
            );
          let complete = false;
          for (let page = 0; page < maxTasks; page++) {
            const result = await processDerivedRefreshPage(
              db,
              options.derivedRefreshPorts,
            );
            if (result.errors.length) throw new Error(result.errors.join("\n"));
            if (result.done) {
              complete = true;
              break;
            }
          }
          if (!complete)
            throw new Error(
              "Synthetic derived refresh exceeded its page budget",
            );
        } else await handleBackgroundTask(db, task);
        tasks.shift();
        handled++;
      }
      return handled;
    },
    restore: () => setCfEnv(undefined),
  };
}
