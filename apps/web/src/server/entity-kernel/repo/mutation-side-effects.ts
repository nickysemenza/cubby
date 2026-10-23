import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import type { LocationId, RunId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  type PublishOptions,
  publishInBackground,
} from "~/server/workflows/background-tasks/publish";

export interface LocationImageChangePorts {
  /** Persist Jobs in the caller's transaction; wake only after its commit. */
  readonly publishTasks: (
    db: Database,
    tasks: readonly BackgroundTaskInput[],
    options: PublishOptions,
  ) => Promise<void>;
}

const productionPorts: LocationImageChangePorts = {
  publishTasks: publishInBackground,
};

/** Call only for authoritative image changes, inside their save transaction. */
export async function registerLocationImageChange(
  db: Database,
  change: { locationId: LocationId; runId?: RunId },
  ports: LocationImageChangePorts = productionPorts,
): Promise<void> {
  await recordChange(db, { kind: "source", categories: ["location"] });
  const requestedAt = new Date().toISOString();
  await ports.publishTasks(
    db,
    [
      { kind: "location-ai.description.refresh", requestedAt, ...change },
      { kind: "location-ai.inventory.refresh", requestedAt, ...change },
    ],
    { source: "location.images" },
  );
}
