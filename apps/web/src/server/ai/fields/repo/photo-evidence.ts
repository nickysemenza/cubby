import type { KernelJson } from "@cubby/schemas/kernel/machinery";

import { photoInventoryObservation } from "~/server/ai/fields/repo/photo-evidence-kind";
import type { Database } from "~/server/db";

export async function appendPhotoInventoryObservation(
  db: Database,
  input: {
    locationId: string;
    runId?: string | null;
    fingerprint: string;
    sourceSnapshot: KernelJson;
    result: KernelJson;
  },
): Promise<void> {
  const { append, evidenceRow } = await import("~/server/kernel/api");
  await append(db, [evidenceRow(photoInventoryObservation, input)], {
    runId: input.runId,
  });
}
