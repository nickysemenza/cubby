import type { ActorContext } from "@cubby/schemas/context";
import type { SourceIdentityResolution } from "@cubby/schemas/source-occurrence-fields";
import { z } from "zod";

import { sourceOccurrence, sourceTransactionRecord } from "~/server/db/schema";
import { constraintViolation } from "~/server/errors/app-error";
import { jsonSnapshot } from "~/server/lib/canonical-json";

import type { SourceIdentityLoaded } from "./source-identity-stages";

type Owner = typeof sourceOccurrence.$inferSelect;
type Observation = typeof sourceTransactionRecord.$inferSelect;
export function checkLockedIdentity(
  input: SourceIdentityResolution,
  initial: Observation,
  initialOwners: Owner[],
  owners: Owner[],
  lockedObservation: Observation | undefined,
) {
  if (
    !lockedObservation ||
    lockedObservation.deletedAt ||
    lockedObservation.occurrenceId !== initial.occurrenceId ||
    lockedObservation.factFingerprint !== input.expectedFactFingerprint
  )
    return constraintViolation(
      "Source evidence changed after review. Read the current evidence before resolving identity.",
    );
  const observation = lockedObservation;
  const originalOwner = owners.find(
    (owner) => owner.id === observation.occurrenceId,
  );
  if (!originalOwner)
    return constraintViolation("Every bank record must have a judgment owner.");
  if (
    originalOwner.version !== input.expectedOccurrenceVersion ||
    owners.some(
      (owner) =>
        owner.acceptedTransactionId !==
        initialOwners.find((before) => before.id === owner.id)
          ?.acceptedTransactionId,
    )
  )
    return constraintViolation("Source ownership changed after review.");
  return { observation, originalOwner };
}

export function selectIdentityOwner(
  input: SourceIdentityResolution,
  observation: Observation,
  originalOwner: Owner,
  owners: Owner[],
  priorAcceptedCode: string | null,
) {
  if (priorAcceptedCode !== input.expectedAcceptedTransactionId)
    return constraintViolation(
      "The accepted transaction changed after review.",
    );
  if (originalOwner.deletedAt || originalOwner.supersededByOccurrenceId)
    return constraintViolation(
      "Retired or replaced source identity must retain its reservation.",
    );
  const owner =
    input.decision === "assign"
      ? owners.find((candidate) => candidate.shortcode === input.occurrenceId)
      : originalOwner;
  if (
    input.decision === "assign" &&
    (owner?.id === originalOwner.id ||
      !owner ||
      owner.identityKind !== "provider" ||
      !owner.currentObservationId ||
      !["legacy", "positioned", "reviewed"].includes(
        originalOwner.identityKind,
      ) ||
      !["ready", "identity_conflict", "ownership_conflict"].includes(
        originalOwner.reviewState,
      ) ||
      owner.source !== observation.source ||
      owner.version !== input.expectedTargetVersion ||
      !["ready", "identity_conflict"].includes(owner.reviewState) ||
      owner.deletedAt ||
      owner.withdrawnAt ||
      owner.supersededByOccurrenceId)
  )
    return constraintViolation(
      "Consolidate only a legacy, positioned or reviewed owner into a current provider occurrence from the same source.",
    );
  return owner;
}

export function planSourceIdentity(
  input: SourceIdentityResolution,
  actor: ActorContext,
  loaded: SourceIdentityLoaded,
  now: Date,
) {
  const { owner, originalOwner, observation, account, target, history } =
    loaded;
  const priorProof = z
    .object({ originalIdentityProof: z.json() })
    .passthrough()
    .safeParse(owner.identityProof);
  const proof = jsonSnapshot.parse({
    originalIdentityProof: priorProof.success
      ? priorProof.data.originalIdentityProof
      : (owner.identityProof ?? null),
    resolvedHistoricalTransactionIds: history.map((item) => item.id),
    resolution: {
      decision: input.decision,
      observationId: observation.id,
      factFingerprint: observation.factFingerprint,
      accountId: account.id,
      acceptedTransactionId: target?.id ?? null,
      note: input.note,
      expectedDisposition: input.expectedDisposition,
      judgment: input.judgment,
      priorWithdrawal: {
        at: originalOwner.withdrawnAt,
        importId: originalOwner.withdrawalImportId,
      },
      userId: actor.userId,
      at: now.toISOString(),
    },
  });
  const beforeOwners =
    input.decision === "assign" ? [originalOwner, owner] : [owner];
  return { proof, beforeOwners };
}
