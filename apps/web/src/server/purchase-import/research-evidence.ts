import { runEntityId } from "@cubby/schemas/identifiers";
import { researchSourceMetadata } from "@cubby/schemas/research";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { ledgerParty, run, runEvidence, runTarget } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import { productionBrowserEvidenceStorage } from "./browser-results";
import { assertResearchRunExecutable } from "./research-execution";

export async function assertResearchWork(
  db: Database,
  rawRunId: string,
  workRef: string,
) {
  await assertResearchRunExecutable(db, rawRunId);
  const [scope] = await getDb(db)
    .select({ run })
    .from(run)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, run.ledgerPartyId),
        eq(ledgerParty.userId, run.actorUserId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(and(eq(run.id, runEntityId.parse(rawRunId)), notDeleted(run)))
    .limit(1);
  if (!scope) throw new Error("Research Run ownership is unavailable.");
  if (!["running", "paused_offline"].includes(scope.run.status))
    throw new Error(`Research Run is fenced in status ${scope.run.status}.`);
  const [target] = await getDb(db)
    .select()
    .from(runTarget)
    .where(and(eq(runTarget.runId, scope.run.id), eq(runTarget.id, workRef)))
    .limit(1);
  if (!target) throw new Error("Research work does not belong to this Run.");
  if (!["pending", "prepared", "needs_evidence"].includes(target.state))
    throw new Error("Research work is settled and closed to writes.");
  return { scope: scope.run, target };
}

export type ResearchEvidenceReader = (
  evidence: typeof runEvidence.$inferSelect,
) => Promise<string>;
export const readRetainedResearchEvidence: ResearchEvidenceReader = async (
  evidence,
) => {
  const reader = productionBrowserEvidenceStorage.get;
  if (!reader)
    throw new Error("Retained research evidence reader is unavailable.");
  return reader(evidence.objectKey);
};

/** References, original bytes, and ownership are checked before semantic judgment. */
export async function loadResearchEvidence(
  db: Database,
  input: { runId: string; workRef: string; evidenceIds: readonly string[] },
  readEvidence: ResearchEvidenceReader = readRetainedResearchEvidence,
) {
  await assertResearchWork(db, input.runId, input.workRef);
  const ids = [...new Set(input.evidenceIds)];
  if (ids.length === 0) return [];
  const rows = await getDb(db)
    .select()
    .from(runEvidence)
    .where(
      and(
        eq(runEvidence.runId, runEntityId.parse(input.runId)),
        eq(runEvidence.targetId, input.workRef),
        inArray(runEvidence.id, ids),
      ),
    );
  if (rows.length !== ids.length)
    throw new Error("Research evidence does not belong to this task.");
  return Promise.all(
    rows.map(async (row) => {
      const content = await readVerifiedResearchEvidence(row, readEvidence);
      return { evidenceId: row.id, metadata: row.sourceMetadata, content };
    }),
  );
}

/** Integrity is shared by active research and read-only historical interpretation. */
export async function readVerifiedResearchEvidence(
  row: typeof runEvidence.$inferSelect,
  readEvidence: ResearchEvidenceReader = readRetainedResearchEvidence,
) {
  const metadata = researchSourceMetadata
    .pick({ researchUploadState: true })
    .loose()
    .parse(row.sourceMetadata);
  if (metadata.researchUploadState === "pending")
    throw new Error("Retained research evidence upload is pending.");
  const content = await readEvidence(row);
  if ((await sha256Hex(content)) !== row.checksum)
    throw new Error("Retained research evidence checksum changed.");
  return content;
}
