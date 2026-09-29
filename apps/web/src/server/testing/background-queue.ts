import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";

import { setCfEnv } from "~/server/cf-env";

/**
 * Route background-task publishes into memory instead of running them inline
 * (the Node fallback) so a test can assert what was queued. Every captured
 * body is parsed through the real envelope schema. Pair with `restore()` in
 * `afterEach`.
 */
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
  return { tasks, restore: () => setCfEnv(undefined) };
}
