import type { RunId } from "@cubby/schemas/identifiers";
import { runTargetOutcomeReceipt } from "@cubby/schemas/run-fields";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { runOperation } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

type OutcomeTarget = z.input<typeof runTargetOutcomeReceipt>["target"];
type FixtureTarget = Omit<
  OutcomeTarget,
  "workKey" | "state" | "completedAt" | "outcome" | "warning" | "diff"
> &
  Partial<
    Pick<OutcomeTarget, "workKey" | "state" | "outcome" | "warning" | "diff">
  > & {
    runId: RunId;
    id?: string;
    createdAt?: Date;
    completedAt?: Date | null;
  };

/** Persist historical outcomes without recreating mutable admission rows. */
export async function writeOutcomeReceipts(
  db: Database,
  targets: readonly FixtureTarget[],
) {
  await getDb(db)
    .insert(runOperation)
    .values(
      targets.map(
        ({ runId, id, createdAt, completedAt, ...target }, index) => ({
          id,
          runId,
          operationId: `synthetic-outcome:${target.entityId}:${target.workKey ?? ""}:${index}`,
          kind: "target_outcome",
          state: "completed" as const,
          inputFingerprint: target.targetFingerprint,
          startedAt: createdAt ?? completedAt ?? new Date(),
          completedAt: completedAt ?? new Date(),
          result: runTargetOutcomeReceipt.parse({
            target: {
              workKey: "",
              state: "pending",
              outcome: null,
              warning: null,
              diff: null,
              ...target,
              completedAt: completedAt?.toISOString() ?? null,
            },
          }),
        }),
      ),
    );
}
