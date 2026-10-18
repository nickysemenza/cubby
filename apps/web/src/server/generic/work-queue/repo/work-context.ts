import type { ActorContext } from "@cubby/schemas/context";
import { financialTransactionShortcode } from "@cubby/schemas/identifiers";
import { runStatus } from "@cubby/schemas/run-fields";
import type { WorkQueueRow } from "@cubby/schemas/work-queue";
import { and, eq, inArray, or } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { run, vendor } from "~/server/db/schema";
import { readFinancialWork } from "~/server/domains/financial-transaction/repo/financial-convergence";

import { workRunLifecycle, type WorkContext } from "./work-explanation";

/** Canonical execution facts enrich the same queue and record projection. */
export async function loadWorkContexts(
  db: Database,
  rows: WorkQueueRow[],
  actor?: ActorContext,
) {
  const contexts = new Map<string, WorkContext>();
  const transactions = [
    ...new Set(
      rows.flatMap((row) =>
        row.source === "reconciliation" &&
        row.kind !== "awaiting_posting" &&
        row.entity === "financialTransaction" &&
        row.id
          ? [financialTransactionShortcode.parse(row.id)]
          : [],
      ),
    ),
  ];
  if (actor && transactions.length) {
    const previews = await readFinancialWork(db, transactions, actor);
    for (const row of rows) {
      if (row.source !== "reconciliation" || row.kind === "awaiting_posting")
        continue;
      const preview = previews.find(
        (preview) => preview.transactionId === row.id,
      );
      if (!preview) continue;
      contexts.set(row.key, {
        // Investigation is actionable even when automatic application lacks
        // proof. A capability preview is not scheduled execution authority.
        reason: preview.blocker
          ? `${row.reason} Automatic convergence: ${preview.blocker}`
          : row.reason,
        effects: preview.effect
          ? {
              certainty: "known",
              changes:
                preview.effect === "already_recorded"
                  ? []
                  : [
                      {
                        action:
                          preview.effect === "link_existing"
                            ? "link"
                            : "create",
                        record: preview.purchaseId
                          ? { entity: "purchase", id: preview.purchaseId }
                          : null,
                        description:
                          preview.effect === "link_existing"
                            ? "Link the accepted Purchase identity to this financial evidence."
                            : "Create an orderless aggregate Purchase and Expense spending from verified payment evidence.",
                      },
                    ],
            }
          : { certainty: "unknown", changes: [] },
      });
    }
  }
  const runs = rows.flatMap((row) =>
    row.entity === "run" && row.id ? [row.id] : [],
  );
  const vendors = rows.flatMap((row) =>
    row.entity === "vendor" && row.id ? [row.id] : [],
  );
  if (!runs.length && !vendors.length) return contexts;
  const executions = await getDb(db)
    .select({
      code: run.shortcode,
      status: run.status,
      failureCode: run.failureCode,
      error: run.dispatchError,
      vendorCode: vendor.shortcode,
      vendorName: vendor.name,
    })
    .from(run)
    .leftJoin(vendor, and(eq(vendor.id, run.vendorId), notDeleted(vendor)))
    .where(
      and(
        notDeleted(run),
        or(
          runs.length ? inArray(run.shortcode, runs) : undefined,
          vendors.length ? inArray(vendor.shortcode, vendors) : undefined,
        ),
      ),
    );
  for (const row of rows) {
    if (
      row.entity === "run" &&
      (row.source === "execution" || row.source === "account")
    ) {
      const execution = executions.find(
        (execution) => execution.code === row.id,
      );
      if (!execution) continue;
      contexts.set(row.key, {
        lifecycle: workRunLifecycle(runStatus.parse(execution.status)),
        readiness: execution.status === "running" ? "ready" : undefined,
        prerequisites:
          execution.failureCode === "execution_limit"
            ? [
                {
                  code: "execution_allowance",
                  state: "missing",
                  reason:
                    execution.error ??
                    "This window's AI budget is spent; paid work resumes in the next window.",
                  record: null,
                },
              ]
            : execution.status === "paused"
              ? [
                  {
                    code: "explicit_resume",
                    state: "missing",
                    reason:
                      "This Run is explicitly paused. A member must resume it.",
                    record: null,
                  },
                ]
              : execution.status === "paused_auth"
                ? [
                    {
                      code: "account_access",
                      state: "missing",
                      reason: "Restore the source account's authorized access.",
                      record: null,
                    },
                  ]
                : execution.status === "paused_offline"
                  ? [
                      {
                        code: "companion_online",
                        state: "missing",
                        reason: "The required companion must reconnect.",
                        record: null,
                      },
                    ]
                  : execution.status === "paused_approval"
                    ? [
                        {
                          code: "member_approval",
                          state: "missing",
                          reason: "Background work will resume automatically.",
                          record: null,
                        },
                      ]
                    : [],
      });
    }
  }
  return contexts;
}
