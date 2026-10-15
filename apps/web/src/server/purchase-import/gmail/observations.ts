import type { ActorContext } from "@cubby/schemas/context";
import {
  emailCandidatePreview,
  type EmailCandidatePreview,
} from "@cubby/schemas/email-candidates";
import {
  emailClassificationObservationInput,
  emailRetrievalFailureInput,
} from "@cubby/schemas/email-observations";
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, desc, eq } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  emailClassificationObservation,
  emailCandidateObservation,
  emailRetrievalFailure,
  email as emailTable,
  run,
  runFinding,
} from "~/server/db/schema";
import { recordFeedback } from "~/server/repo/assessment";
import { ensureEmailAssessment } from "~/server/repo/assessment-email";
import { databaseForTransaction } from "~/server/repo/database-helpers";
import { withTransaction } from "~/server/repo/database-helpers";
import { readRetainedMail } from "~/server/repo/retained-mail";
import { findOrCreateWithShortcode } from "~/server/repo/shortcode-utils";

/** The caller holds the Email lock; stored unknown telemetry remains unknown. */
export async function snapshotStoredEmailPrediction(
  tx: DrizzleTransaction,
  email: typeof emailTable.$inferSelect,
) {
  if (email.classification === null) return null;
  const stage = emailClassificationObservationInput.shape.stage.safeParse(
    email.classificationStage,
  );
  const history = await tx
    .select()
    .from(emailClassificationObservation)
    .where(eq(emailClassificationObservation.emailId, email.id))
    .orderBy(desc(emailClassificationObservation.createdAt));
  const previous = history.find(
    (row) =>
      row.checksum === email.checksum &&
      row.classification === email.classification &&
      row.stage === (stage.success ? stage.data : null) &&
      row.reason === email.classificationReason &&
      row.classificationVersion === email.classificationVersion,
  );
  if (previous) return previous;
  const [owner] = email.runId
    ? await tx
        .select({ id: run.id })
        .from(run)
        .where(
          and(
            eq(run.id, email.runId),
            eq(run.ledgerPartyId, email.ledgerPartyId),
          ),
        )
        .limit(1)
    : [];
  const [snapshot] = await tx
    .insert(emailClassificationObservation)
    .values({
      ...emailClassificationObservationInput.parse({
        emailId: email.id,
        runId: owner?.id ?? null,
        checksum: email.checksum,
        classification: email.classification,
        stage: stage.success ? stage.data : null,
        reason: email.classificationReason,
        classificationVersion: email.classificationVersion,
      }),
      createdAt: new Date(
        Math.max(Date.now(), (history[0]?.createdAt.getTime() ?? 0) + 1),
      ),
    })
    .returning();
  if (!snapshot)
    throw new Error("Email historical prediction insert returned no row");
  return snapshot;
}

function sameClassificationObservation(
  previous: typeof emailClassificationObservation.$inferSelect,
  parsed: z.output<typeof emailClassificationObservationInput>,
) {
  return (
    previous.runId === parsed.runId &&
    previous.checksum === parsed.checksum &&
    previous.classification === parsed.classification &&
    previous.stage === parsed.stage &&
    previous.reason === parsed.reason &&
    previous.classificationVersion === parsed.classificationVersion &&
    previous.model === parsed.model &&
    previous.promptVersion === parsed.promptVersion &&
    previous.operation === parsed.operation &&
    previous.usageId === parsed.usageId &&
    isEqual(previous.conflict, parsed.conflict)
  );
}

/** Append predictions independently of effective routing and member labels. */
export async function recordEmailClassificationObservation(
  db: Database,
  input: z.input<typeof emailClassificationObservationInput>,
  actor?: ActorContext,
) {
  const parsed = emailClassificationObservationInput.parse(input);
  return withTransaction(db, async (tx) => {
    const [initial] = await tx
      .select()
      .from(emailTable)
      .where(eq(emailTable.id, parseEntityId("email", parsed.emailId)))
      .limit(1);
    if (!initial)
      throw new Error("Email classification observation has no Email");
    if (parsed.runId) {
      const [owner] = await tx
        .select()
        .from(run)
        .where(
          and(
            eq(run.id, runEntityId.parse(parsed.runId)),
            eq(run.ledgerPartyId, initial.ledgerPartyId),
          ),
        )
        .for("update")
        .limit(1);
      if (!owner)
        throw new Error(
          "Email classification observation Run ownership does not match",
        );
    }
    const [email] = await tx
      .select()
      .from(emailTable)
      .where(eq(emailTable.id, initial.id))
      .for("update")
      .limit(1);
    if (!email || email.ledgerPartyId !== initial.ledgerPartyId)
      throw new Error("Email classification observation ownership changed");
    await snapshotStoredEmailPrediction(tx, email);
    const [previous] = await tx
      .select()
      .from(emailClassificationObservation)
      .where(eq(emailClassificationObservation.emailId, parsed.emailId))
      .orderBy(
        desc(emailClassificationObservation.createdAt),
        desc(emailClassificationObservation.id),
      )
      .limit(1);
    if (previous && sameClassificationObservation(previous, parsed))
      return previous;
    const [observation] = await tx
      .insert(emailClassificationObservation)
      .values({
        ...parsed,
        createdAt: new Date(
          Math.max(Date.now(), (previous?.createdAt.getTime() ?? 0) + 1),
        ),
      })
      .returning();
    if (!observation)
      throw new Error(
        "Email classification observation insert returned no row",
      );
    const assessment = await ensureEmailAssessment(
      databaseForTransaction(tx),
      observation.id,
    );
    if (parsed.stage === "resolution")
      await recordFeedback(databaseForTransaction(tx), {
        assessmentId: assessment.id,
        operationId: "resolution",
        verdict: "correct",
        authority: actor
          ? actor.runId
            ? "automatic"
            : "member"
          : parsed.runId
            ? "automatic"
            : "unknown",
        actorUserId: actor?.userId ?? null,
        intent: "apply",
        correction: { present: true, value: parsed.classification },
        reason: parsed.reason,
        metadata: { kind: "email_resolution", predictionId: observation.id },
      });
    // A review conflict is a worklist filter, not a Run finding.
    if (parsed.conflict?.kind === "accepted_unrelated" && parsed.runId)
      await tx.insert(runFinding).values({
        runId: runEntityId.parse(parsed.runId),
        ledgerPartyId: email.ledgerPartyId,
        entityId: email.id,
        entityKind: "email",
        kind: "other",
        summary:
          "Email was classified unrelated despite an accepted Purchase association",
        evidenceFingerprint: `email-classification:${observation.id}:${observation.checksum ?? "unknown"}`,
        proposedFix: {
          emailId: email.id,
          predictionId: observation.id,
          conflict: parsed.conflict,
        },
      });
    return observation;
  });
}

/** Missing originals retain raw provider diagnostics without inventing a prediction. */
export async function recordEmailRetrievalFailure(
  db: Database,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    messageId: string;
    runId?: string;
    httpStatus: number | null;
    error: string;
  },
) {
  await withTransaction(db, async (tx) => {
    const { row } = await findOrCreateWithShortcode(tx, "email", {
      where: and(
        eq(
          emailTable.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
        eq(emailTable.provider, "gmail"),
        eq(emailTable.mailboxId, input.mailboxId),
        eq(emailTable.messageId, input.messageId),
      ),
      values: () => ({
        ledgerPartyId: parseEntityId("ledgerParty", input.ledgerPartyId),
        provider: "gmail",
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        checksum: "unavailable",
        status: "pending" as const,
        executionPolicy: "classification_only" as const,
      }),
    });
    await tx.insert(emailRetrievalFailure).values(
      emailRetrievalFailureInput.parse({
        emailId: row.id,
        runId: input.runId ?? null,
        httpStatus: input.httpStatus,
        error: scrubErrorMessage(input.error),
      }),
    );
  });
}

/** Persist a checksum-fenced immutable preview; selection grants no import authority. */
export async function recordEmailCandidateObservation(
  db: Database,
  input: { emailId: string; preview: EmailCandidatePreview },
) {
  const preview = emailCandidatePreview.parse(input.preview);
  if (preview.status === "selected") {
    const selected = preview.candidates[preview.decision.selectedIndex ?? -1];
    if (
      !selected ||
      selected.id !== preview.candidateId ||
      !isEqual(selected, preview.candidate)
    )
      throw new Error(
        "Email candidate index does not name its exact evidence candidate",
      );
  }
  return withTransaction(db, async (tx) => {
    const [email] = await tx
      .select()
      .from(emailTable)
      .where(eq(emailTable.id, parseEntityId("email", input.emailId)))
      .for("update")
      .limit(1);
    if (
      !email ||
      !email.orderMailId ||
      email.classification !== "related" ||
      email.contentClearedAt ||
      email.checksum !== preview.checksum ||
      `${email.provider}:${email.mailboxId}:${email.messageId}` !==
        preview.sourceKey
    )
      throw new Error("Email candidate source changed before persistence");
    const [original] = await readRetainedMail(
      tx,
      {
        ledgerPartyIds: [email.ledgerPartyId],
        mailboxId: email.mailboxId,
        messageId: email.messageId,
        orderMailIds: [email.orderMailId],
      },
      "update",
    );
    if (!original)
      throw new Error("Email candidate source changed before persistence");
    const content =
      original.content.bodyHtml ?? original.content.bodyText ?? "";
    if ((await sha256Hex(content)) !== preview.contentChecksum)
      throw new Error("Email candidate source changed before persistence");
    const { prepareEmailEvidenceCandidates } =
      await import("./evidence-candidates");
    const prepared = await prepareEmailEvidenceCandidates({
      sourceKey: preview.sourceKey,
      checksum: preview.checksum,
      content,
    });
    if (
      JSON.stringify(prepared.candidates) !== JSON.stringify(preview.candidates)
    )
      throw new Error(
        "Email candidate evidence roster changed before persistence",
      );
    if (preview.runId) {
      const [owner] = await tx
        .select()
        .from(run)
        .where(
          and(
            eq(run.id, runEntityId.parse(preview.runId)),
            eq(run.ledgerPartyId, email.ledgerPartyId),
          ),
        )
        .for("update")
        .limit(1);
      if (!owner)
        throw new Error("Email candidate Run ownership does not match");
    }
    const [previous] = await tx
      .select()
      .from(emailCandidateObservation)
      .where(eq(emailCandidateObservation.emailId, email.id))
      .orderBy(
        desc(emailCandidateObservation.createdAt),
        desc(emailCandidateObservation.id),
      )
      .limit(1);
    if (previous && isEqual(previous.preview, preview)) return previous;
    const [record] = await tx
      .insert(emailCandidateObservation)
      .values({ emailId: email.id, runId: preview.runId, preview })
      .returning();
    if (!record)
      throw new Error("Email candidate observation insert returned no row");
    return record;
  });
}
