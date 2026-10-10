import type { ActorContext } from "@cubby/schemas/context";
import {
  browserPageCapture,
  retainedCaptureInterpretation,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  ledgerParty,
  run,
  runEvidence,
  runFactEvidence,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  insertOperation,
  readOperation,
  type OperationKey,
} from "~/server/repo/run-operation";

import { derivePageCapture, PAGE_DERIVATION_REVISION } from "./browser-page";
import { browserCommandRecord } from "./browser-results";
import {
  readVerifiedResearchEvidence,
  type ResearchEvidenceReader,
} from "./research-evidence";

/** Historical interpretation never refreshes the command's immutable replay page. */
export async function rederiveRetainedCapture(
  db: Database,
  input: { actor: ActorContext; key: OperationKey },
  reader?: ResearchEvidenceReader,
) {
  const client = getDb(db);
  const [scope] = await client
    .select({ id: run.id, retiredAt: run.retiredAt })
    .from(run)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, run.ledgerPartyId),
        eq(ledgerParty.userId, input.actor.userId),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(run.id, input.key.runId),
        eq(run.actorUserId, input.actor.userId),
        notDeleted(run),
      ),
    )
    .limit(1);
  if (!scope || scope.retiredAt !== null)
    throw new Error(
      "Retained capture Run ownership is unavailable or retired.",
    );
  const original = await readOperation(client, input.key);
  if (original?.kind !== "browser_command")
    throw new Error("Retained browser command is unavailable.");
  const record = browserCommandRecord.parse(original.result);
  const page = record.page;
  if (
    !page ||
    record.command.runID !== input.key.runId ||
    record.command.operationId !== input.key.operationId
  )
    throw new Error("Retained capture does not belong to its command.");
  const [evidence] = await client
    .select()
    .from(runEvidence)
    .where(
      and(
        eq(runEvidence.id, page.domEvidenceId),
        eq(runEvidence.runId, input.key.runId),
        eq(runEvidence.targetId, record.workRef),
        eq(runEvidence.kind, "browser_capture"),
      ),
    )
    .limit(1);
  if (!evidence)
    throw new Error("Retained capture evidence does not belong to this task.");
  const html = await readVerifiedResearchEvidence(evidence, reader);
  const key = {
    runId: input.key.runId,
    operationId: `capture-interpretation:${input.key.operationId}:${PAGE_DERIVATION_REVISION}`,
  };
  const fingerprint = await sha256Hex(
    JSON.stringify({
      sourceOperation: input.key.operationId,
      checksum: evidence.checksum,
      revision: PAGE_DERIVATION_REVISION,
    }),
  );
  const replay = await readOperation(client, key);
  if (replay) {
    if (replay.state !== "completed" || replay.inputFingerprint !== fingerprint)
      throw new Error(
        "Retained capture interpretation replay is inconsistent.",
      );
    return retainedCaptureInterpretation.parse(replay.result);
  }
  const operation = record.command.operation;
  if (!("allowedHosts" in operation))
    throw new Error("Retained command has no page-reading host authority.");
  const capture = derivePageCapture({
    html,
    sourceURL: page.capture.sourceURL,
    title: page.capture.title,
    capturedAt: page.capture.capturedAt,
    allowedHosts: operation.allowedHosts,
    requestedURL:
      operation.type === "navigate"
        ? operation.url
        : operation.type === "read"
          ? (operation.recoveryURL ?? null)
          : null,
    evidence: page.capture.evidence,
    truncated: page.research.observation.truncated,
  });
  const facts = await client
    .selectDistinct({ fieldPath: runFactEvidence.fieldPath })
    .from(runFactEvidence)
    .where(eq(runFactEvidence.evidenceId, evidence.id));
  const result = retainedCaptureInterpretation.parse({
    supportedFactFields: facts.map((fact) => fact.fieldPath).sort(),
    evidenceId: evidence.id,
    originalVersion: page.capture.captureVersion,
    capture,
    changedFields: browserPageCapture
      .keyof()
      .options.filter(
        (field) =>
          JSON.stringify(page.capture[field]) !==
          JSON.stringify(capture[field]),
      ),
  });
  await insertOperation(
    client,
    {
      ...key,
      kind: "capture_interpretation",
      state: "completed",
      inputFingerprint: fingerprint,
      result,
    },
    { ifAbsent: true },
  );
  const persisted = await readOperation(client, key);
  if (
    persisted?.state !== "completed" ||
    persisted.inputFingerprint !== fingerprint
  )
    throw new Error("Retained capture interpretation did not persist.");
  return retainedCaptureInterpretation.parse(persisted.result);
}
