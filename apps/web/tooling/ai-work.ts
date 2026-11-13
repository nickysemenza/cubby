import {
  advanceStepRun,
  type StepPlan,
} from "~/server/domains/run/service/step-run";
import { readRunPass } from "~/server/domains/run/repo/run-execution";
import { withRunPassFixture } from "~/server/workflows/runs/pass.fixtures";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import type { RunId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { run, runStep } from "~/server/db/schema";
import { getDb } from "~/server/db/helpers";
import {
  advanceAiWorkRun,
  type AiWorkPorts,
} from "~/server/domains/run/service/ai-work";
import { reclassifyEmails } from "~/server/domains/purchase-import/service/gmail/reclassify";
import { loadMailReclassificationRead } from "~/server/domains/run/repo/run-reclassification-read";
import { emailReclassifyResults } from "@cubby/schemas/email-actions";
import type { z } from "zod";

export async function reclassifyForTest(
  ...args: Parameters<typeof reclassifyEmails>
) {
  const [db, input, actor, ports] = args;
  const submitted = await reclassifyEmails(db, input, actor, {
    ...ports,
  });
  const results: z.infer<typeof emailReclassifyResults> = [];
  for (const code of submitted.runIds) {
    const [owner] = await getDb(db)
      .select()
      .from(run)
      .where(eq(run.shortcode, code));
    if (!owner?.ledgerPartyId)
      throw new Error("Synthetic reclassification owner is missing");
    await driveAiWork(db, owner.id, { reclassification: ports });
    const read = await loadMailReclassificationRead(db, code, {
      userId: actor.userId,
      ledgerPartyId: owner.ledgerPartyId,
    });
    results.push(...(read?.receipts?.results ?? []));
  }
  results.sort(
    (left, right) => input.ids.indexOf(left.id) - input.ids.indexOf(right.id),
  );
  return { ...submitted, results };
}

/** Use persisted Pass claims and Run checkpoints, substituting only provider seams and short waits. */
export async function driveAiWork(
  db: Database,
  id: RunId,
  ports: AiWorkPorts = {},
  plan?: StepPlan,
) {
  for (let cycle = 0; cycle < 205; cycle++) {
    const execution = await readRunPass(db, id);
    if (!execution) throw new Error("Synthetic Run execution is missing");
    if (["done", "stuck", "cancelled"].includes(execution.state)) return;
    const done = await withRunPassFixture(db, id, async () => {
      const [owner] = await getDb(db).select().from(run).where(eq(run.id, id));
      const params = { runId: id, attempt: execution.generation ?? 1 };
      if (owner?.purpose === "sweep") {
        await getDb(db)
          .update(runStep)
          .set({ meta: sql`${runStep.meta} - 'capacityUntil'` })
          .where(eq(runStep.runId, id));
        const result = await advanceStepRun(db, params, plan);
        return result.kind === "finished" || result.kind === "lost";
      }
      return !(await advanceAiWorkRun(db, params, ports));
    });
    if (done) {
      await repositoryQueries(db).execute(
        sql`UPDATE "Pass" SET "doneAt" = now() WHERE name = 'run.execute' AND key = ${id}`,
      );
      return;
    }
  }
  throw new Error("Synthetic AI work did not settle within its bounded pages");
}
