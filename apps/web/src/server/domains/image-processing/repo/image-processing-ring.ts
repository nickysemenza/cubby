import { createLogger } from "@cubby/worker-tracing";

import { getExecutionCtx, getImageProcessingNamespace } from "~/server/cf-env";
import type { Database, DrizzleTransaction } from "~/server/db";
import { runAfterCommit } from "~/server/db/helpers/core";

import type { ImageProcessingCompanionRpc } from "./companion-rpc";

const log = createLogger("image-processing");

type ImageProcessingStub = ReturnType<
  NonNullable<ReturnType<typeof getImageProcessingNamespace>>["getByName"]
>;

function companionRpc(value: ImageProcessingStub): ImageProcessingCompanionRpc {
  // SAFETY: this binding names ImageProcessingDurableObject, whose public RPC
  // surface implements ImageProcessingCompanionRpc.
  return value as ImageProcessingCompanionRpc;
}

/** Ring every connected companion now; a missing binding or socket reaches none. */
export async function ringImageProcessingCompanions(): Promise<number> {
  const namespace = getImageProcessingNamespace();
  if (!namespace) return 0;
  try {
    return await companionRpc(namespace.getByName("household")).ring();
  } catch (error) {
    // A lost ring only delays work: a companion pulls again on connect.
    log.warn("companion ring failed", { error });
    return 0;
  }
}

const ringing = new WeakSet<object>();

/**
 * Ring companions once after the enqueuing transaction commits. Device work
 * is parked for device pulls; the server drain never polls it.
 */
export async function ringImageProcessingCompanionsAfterCommit(
  db: Database | DrizzleTransaction,
) {
  if (ringing.has(db)) return;
  ringing.add(db);
  await runAfterCommit(db, async () => {
    const ring = ringImageProcessingCompanions();
    const ctx = getExecutionCtx();
    if (ctx) ctx.waitUntil(ring);
    else await ring;
  });
}
