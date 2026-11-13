import { type JOB_KIND_POLICY } from "@cubby/schemas/job";
import { sql } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { emailPurchaseDiscoveryDrain } from "~/server/domains/connection/service/email-purchase-discovery";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import { type PermitRuntime } from "~/server/generic/jobs/service/permits";
import type { JobHandler, JobHandlers } from "~/server/generic/jobs/types";
import { kernelDueSql, kernelNextSql } from "~/server/kernel/runner";
import { backgroundJobHandlers } from "~/server/workflows/background-tasks/kinds";
import { wakeAt, wakeJobs } from "~/server/workflows/background-tasks/publish";

export const productionJobHandlers: JobHandlers = {
  ...backgroundJobHandlers,
} satisfies Record<
  Exclude<keyof typeof JOB_KIND_POLICY, "background.drain">,
  JobHandler
>;

/** Each kernel page runs dirty scopes, asks and passes for at most this long. */
const KERNEL_PAGE_BUDGET_MS = 20_000;

/** The evidence-facts kernel: dirty scopes, asks and passes (ADR 0029 section 7). */
const kernelDrain: BackgroundDrain = {
  name: "kernel",
  label: (unit) => (unit === "kernel" ? "Reconcile records" : undefined),
  due: kernelDueSql,
  next: kernelNextSql,
  async page(db) {
    const { runProductionKernel } = await import("~/server/kernel/api");
    return {
      claimed: await runProductionKernel(db, {
        budgetMs: KERNEL_PAGE_BUDGET_MS,
      }),
    };
  },
};

// Built per permit: production ports participate in this module's import cycle.
const productionDrains = (): readonly BackgroundDrain[] => [
  kernelDrain,
  emailPurchaseDiscoveryDrain,
];

/** Every production drain's `due` rows, for reads that report owed drain units. */
export const productionDrainDues = () =>
  productionDrains().map((drain) => ({
    name: drain.name,
    due:
      drain.due() ??
      sql`SELECT NULL::text AS unit, false AS demand, NULL::timestamp AS since WHERE false`,
    label: drain.label,
    stream: drain.stream,
    covers: drain.covers,
  }));

/** The production permit runtime: these handlers and drains, waking through the background queue. */
export function productionPermitRuntime(
  db: Database,
  captureException: (error: UnparsedError, unit?: string) => void,
): PermitRuntime {
  return {
    db,
    handlers: productionJobHandlers,
    drains: productionDrains(),
    ports: {
      send: (at, source, recover) =>
        at ? wakeAt(at, { source, recover }) : wakeJobs({ source }),
      captureException,
    },
  };
}
