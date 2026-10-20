import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { appSettings } from "~/server/db/schema";

// Separate from AI policy activation: every successful code deployment advances this epoch.
export const WORKFLOW_DEPLOYMENT_SETTINGS_ID =
  "a2f652d2-dac2-4005-8dc0-7986d9861b15";
export const WORKFLOW_CONTROL_EVENT = "execution-control";
export const workflowDeploymentActivation = z.object({
  epoch: z.number().int().positive(),
  deploymentId: z.string().min(1),
  workerVersion: z.string().min(1),
  activatedAt: z.string().datetime(),
  wakes: z
    .record(
      z.string(),
      z.object({
        cursor: z.string().nullable(),
        complete: z.boolean(),
      }),
    )
    .default({}),
});
export type WorkflowDeploymentActivation = z.infer<
  typeof workflowDeploymentActivation
>;

export async function readWorkflowDeployment(db: Database) {
  const [row] = await getDb(db)
    .select({ metadata: appSettings.metadata })
    .from(appSettings)
    .where(eq(appSettings.id, WORKFLOW_DEPLOYMENT_SETTINGS_ID));
  return row ? workflowDeploymentActivation.parse(row.metadata) : null;
}

/** Only deployment tooling calls this after verifying the actively serving provider deployment. */
export async function activateWorkflowDeployment(
  db: Database,
  input: {
    deploymentId: string;
    workerVersion: string;
    expectedEpoch: number;
  },
) {
  return withTransactionDatabase(db, async (tx) => {
    await getDb(tx)
      .insert(appSettings)
      .values({
        id: WORKFLOW_DEPLOYMENT_SETTINGS_ID,
        metadata: {},
      })
      .onConflictDoNothing();
    const [stored] = await getDb(tx)
      .select({ metadata: appSettings.metadata })
      .from(appSettings)
      .where(eq(appSettings.id, WORKFLOW_DEPLOYMENT_SETTINGS_ID))
      .for("update");
    const prior =
      stored?.metadata && Object.keys(stored.metadata).length
        ? workflowDeploymentActivation.parse(stored.metadata)
        : null;
    if (prior?.deploymentId === input.deploymentId) {
      if (prior.workerVersion !== input.workerVersion)
        throw new Error("A deployment cannot change its Worker version");
      return prior;
    }
    if ((prior?.epoch ?? 0) !== input.expectedEpoch)
      throw new Error(
        "Workflow activation changed while deployment was in progress",
      );
    const next = workflowDeploymentActivation.parse({
      epoch: input.expectedEpoch + 1,
      deploymentId: input.deploymentId,
      workerVersion: input.workerVersion,
      activatedAt: new Date().toISOString(),
      wakes: {},
    });
    await getDb(tx)
      .update(appSettings)
      .set({ metadata: next, updatedAt: new Date() })
      .where(eq(appSettings.id, WORKFLOW_DEPLOYMENT_SETTINGS_ID));
    return next;
  });
}

export async function recordWorkflowWakePage(
  db: Database,
  input: {
    epoch: number;
    workflow: string;
    cursor: string | null;
    complete: boolean;
  },
) {
  return withTransactionDatabase(db, async (tx) => {
    const [stored] = await getDb(tx)
      .select({ metadata: appSettings.metadata })
      .from(appSettings)
      .where(eq(appSettings.id, WORKFLOW_DEPLOYMENT_SETTINGS_ID))
      .for("update");
    const current = workflowDeploymentActivation.parse(stored?.metadata);
    if (current.epoch !== input.epoch) return false;
    current.wakes[input.workflow] = {
      cursor: input.cursor,
      complete: input.complete,
    };
    await getDb(tx)
      .update(appSettings)
      .set({ metadata: current, updatedAt: new Date() })
      .where(eq(appSettings.id, WORKFLOW_DEPLOYMENT_SETTINGS_ID));
    return true;
  });
}
