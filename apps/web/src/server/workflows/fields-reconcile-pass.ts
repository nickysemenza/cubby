import { z } from "zod";

import { definePass, reconcileNow } from "~/server/kernel/api";
import { ClaimLapsedError } from "~/server/kernel/claim";

const request = z.object({ key: z.string(), runId: z.uuid().nullable() });

/** A requested field refresh admits its scope and attributes resulting Asks to the Run. */
export const fieldsReconcilePass = definePass({
  name: "fields.reconcile",
  async run(db, cursor, claim) {
    const input = request.parse(cursor);
    if (!(await claim.renew())) throw new ClaimLapsedError();
    // The scope owns its claim transactions; request replay reuses its Answers.
    const outcomes = await reconcileNow(
      db,
      [{ kind: "fields", key: input.key }],
      {
        waitMs: 0,
        ...(input.runId ? { runId: input.runId } : {}),
      },
    );
    const failed = outcomes.find((outcome) => outcome.status === "failed");
    if (failed)
      throw failed.cause ?? new Error(failed.error ?? "Field refresh failed");
    // An Answer gap is admitted work owned by the Ask; an empty wait means the scope claim was busy.
    const waiting = outcomes.some(
      (outcome) =>
        (outcome.status === "waiting" && !outcome.gaps.length) ||
        outcome.status === "conflict",
    );
    return {
      cursor,
      done: !waiting,
      ...(waiting
        ? {
            waitCause: "in_flight" as const,
            availableAt: new Date(Date.now() + 15_000),
          }
        : {}),
    };
  },
});
