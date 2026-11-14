import type { ActorContext } from "@cubby/schemas/context";
import type { SourceIdentityResolution } from "@cubby/schemas/source-occurrence-fields";
import { z } from "zod";

import type {
  financialAccount,
  financialEvidenceAlias,
  financialTransaction,
  sourceOccurrence,
  sourceTransactionRecord,
} from "~/server/db/retained-tables";
import { constraintViolation } from "~/server/errors/app-error";
import { jsonSnapshot } from "~/server/lib/canonical-json";

type Owner = typeof sourceOccurrence.$inferSelect;
type Observation = typeof sourceTransactionRecord.$inferSelect;
type Alias = typeof financialEvidenceAlias.$inferSelect;

/** The rows `lockAndLoadSourceIdentity` holds locks on for one reviewed resolution. */
export type SourceIdentityLoaded = {
  owners: Owner[];
  observation: Observation;
  originalOwner: Owner;
  owner: Owner;
  account: typeof financialAccount.$inferSelect;
  financialJudgment:
    | SourceIdentityResolution["judgment"]
    | {
        disposition: "open";
        dispositionReason: null;
        dispositionNote: null;
      };
  closure: Observation[];
  head: Observation | undefined;
  history: { id: string; code: string }[];
  target: { id: typeof financialTransaction.$inferSelect.id } | undefined;
};
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

/**
 * Source identity resolution is two steps: `planSourceIdentity` turns the
 * locked rows and the reviewed decision into this closed list of writes, and
 * `applySourceIdentity` executes it.
 */
type SourceIdentityWrite =
  | {
      kind: "release_accepted_owner";
      alias: typeof financialEvidenceAlias.$inferInsert;
    }
  | {
      kind: "retire_owner";
      id: Owner["id"];
      set: Partial<typeof sourceOccurrence.$inferInsert>;
    }
  | { kind: "move_evidence"; from: Owner["id"]; to: Owner["id"] }
  | {
      kind: "set_owner";
      id: Owner["id"];
      set: Partial<typeof sourceOccurrence.$inferInsert>;
      /**
       * A consolidation does not waive other overlaps or unlock a conflicted
       * provider. The overlap is read after the evidence moved, so the write
       * carries the check: a remaining overlap sets `identity_conflict`,
       * otherwise `ready`. Absent, the state is `ready`.
       */
      overlap?: { source: string; providerIdentity: string | null };
    }
  | {
      kind: "audit_resolution";
      ownerIds: Owner["id"][];
      beforeOwners: Owner[];
      beforeAliases: Alias[];
      closure: Observation[];
      /** The retired owner joins the after-state of a consolidation. */
      retired: boolean;
    }
  | { kind: "record_change" };

export type SourceIdentityPlan = {
  writes: SourceIdentityWrite[];
  result: { source: string; chargeKey: string };
};

export function planSourceIdentity(
  input: SourceIdentityResolution,
  actor: ActorContext,
  loaded: SourceIdentityLoaded,
  beforeAliases: Alias[],
  now: Date,
): SourceIdentityPlan {
  const {
    owners,
    observation,
    originalOwner,
    owner,
    account,
    financialJudgment,
    closure,
    history,
    target,
  } = loaded;
  const assign = input.decision === "assign";
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
  const writes: SourceIdentityWrite[] = [];
  if (
    originalOwner.acceptedTransactionId &&
    (assign || originalOwner.acceptedTransactionId !== (target?.id ?? null))
  )
    writes.push({
      kind: "release_accepted_owner",
      alias: {
        source: originalOwner.source,
        kind: "transaction_ref",
        value: originalOwner.shortcode,
        observationId: originalOwner.currentObservationId,
        occurrenceId: originalOwner.id,
        historicalTransactionId: originalOwner.acceptedTransactionId,
        provenanceKey: `reviewed-owner-release:${originalOwner.id}:${originalOwner.version}`,
        provenance: jsonSnapshot.parse({
          kind: "reviewed_owner_release",
          note: input.note,
          userId: actor.userId,
          previousOwner: originalOwner,
        }),
        scopeEvidence: jsonSnapshot.parse({
          identityKind: originalOwner.identityKind,
          identityScope: originalOwner.identityScope,
        }),
        deletedAt: now,
      },
    });
  if (assign) {
    // Immediate membership FKs require clearing the old head before moving any record.
    writes.push(
      {
        kind: "retire_owner",
        id: originalOwner.id,
        set: {
          currentObservationId: null,
          accountId: null,
          acceptedTransactionId: null,
          supersededByOccurrenceId: owner.id,
          replacementObservationId: null,
          identityProof: jsonSnapshot.parse({
            kind: "consolidated",
            previousOwner: originalOwner,
            survivorId: owner.id,
            note: input.note,
            userId: actor.userId,
          }),
          version: originalOwner.version + 1,
          updatedAt: now,
        },
      },
      { kind: "move_evidence", from: originalOwner.id, to: owner.id },
    );
  }
  writes.push({
    kind: "set_owner",
    id: owner.id,
    set: {
      lastObservedAt:
        owner.lastObservedAt > originalOwner.lastObservedAt
          ? owner.lastObservedAt
          : originalOwner.lastObservedAt,
      currentObservationId: assign
        ? owner.currentObservationId
        : observation.id,
      accountId: account.id,
      ...financialJudgment,
      acceptedTransactionId: target?.id ?? null,
      withdrawnAt: assign ? owner.withdrawnAt : null,
      withdrawalImportId: assign ? owner.withdrawalImportId : null,
      identityProof: proof,
      version: owner.version + 1,
      updatedAt: now,
    },
    overlap: assign
      ? { source: owner.source, providerIdentity: owner.providerIdentity }
      : undefined,
  });
  writes.push(
    {
      kind: "audit_resolution",
      ownerIds: owners.map((item) => item.id),
      beforeOwners: assign ? [originalOwner, owner] : [owner],
      beforeAliases,
      closure,
      retired: assign,
    },
    { kind: "record_change" },
  );
  return {
    writes,
    result: { source: owner.source, chargeKey: owner.shortcode },
  };
}
