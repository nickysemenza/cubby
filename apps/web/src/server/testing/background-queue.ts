import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";

import { setCfEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";

/** Capture real queue envelopes. Tests explicitly drain side effects before reading them. */
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
    async drain(db: Database, maxTasks = 10_000): Promise<number> {
      const { handleBackgroundTask } =
        await import("~/server/workflows/background-tasks/handle");
      let handled = 0;
      while (tasks.length > 0) {
        if (handled >= maxTasks)
          throw new Error(
            `Background queue drain exceeded ${maxTasks} tasks; possible cascade cycle`,
          );
        const task = tasks[0]!;
        await handleBackgroundTask(db, task);
        tasks.shift();
        handled++;
      }
      return handled;
    },
    restore: () => setCfEnv(undefined),
  };
}
