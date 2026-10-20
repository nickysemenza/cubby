import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";

import { setCfEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import type { DerivedRefreshPorts } from "~/server/generic/derived-refresh/refresh-ports.boundary";

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
