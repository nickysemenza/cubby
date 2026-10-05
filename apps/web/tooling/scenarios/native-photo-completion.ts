import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

import { seedProposedPhotoRun } from "./native-qa";

/** A stopped photo Run must redraw completion after its last selected group is approved. */
export async function runNativePhotoCompletionJourney(input: {
  pool: Pool;
  userId: string;
  artifacts: string;
  replay: (journey: string, variables: Record<string, string>) => Promise<void>;
}): Promise<string> {
  const variables = await seedProposedPhotoRun(input.pool, input.userId, {
    finalReview: true,
  });
  await input.replay("photo-completion.ad", variables);
  const { rows } = await input.pool.query<{ status: string; state: string }>(
    `SELECT r.status, g.state FROM "Run" r JOIN "PhotoGroupProposal" g ON g."runId" = r.id
     WHERE r.shortcode = $1`,
    [variables.PHOTO_RUN_ID],
  );
  if (
    rows.length !== 1 ||
    rows[0]?.status !== "completed" ||
    rows[0]?.state !== "committed"
  )
    throw new Error("The final reviewed photo group did not complete its Run");
  const evidence = path.join(
    input.artifacts,
    "native-photo-completion-result.json",
  );
  writeFileSync(
    evidence,
    `${JSON.stringify({ transition: "needs_review -> completed", selectedReadyGroups: 1, ...rows[0] }, null, 2)}\n`,
  );
  return evidence;
}
