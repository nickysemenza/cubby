import type { RecordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { moneyToMinor } from "@cubby/shared";
import { z } from "zod";

import {
  sourceOccurrence,
  sourceTransactionRecord,
  transactionImport,
  transactionImportRecord,
} from "~/server/db/schema";
import { providerIdentityClaims } from "~/server/domains/transaction-import/repo/source-transaction-record-identity";
import { constraintViolation } from "~/server/errors/app-error";

import type {
  SourceIntakeLoaded,
  SourceIntakePrepared,
} from "./source-intake-stages";
import type { AdoptionFacts } from "./source-intake-stages";

type Owner = typeof sourceOccurrence.$inferSelect;
type Observation = typeof sourceTransactionRecord.$inferSelect;
type Member = {
  membership: typeof transactionImportRecord.$inferSelect;
  observation: Observation;
  legacyAlias: string | null;
};

export function planAdoption(
  source: string,
  locked: ReadonlyArray<Owner>,
  observedAt: Date,
  facts: AdoptionFacts,
) {
  const { incoming, antecedents, ownerSizes } = facts;
  const adopted = new Map<string, Owner>();
  const targets = new Map<string, number>();
  const plans = incoming.flatMap((row) => {
    const identity = row.identity!;
    const prior = antecedents.filter(
      (record) => record.providerTransactionId === identity.providerId,
    );
    const ownerIds = new Set(prior.map((record) => record.occurrenceId));
    const owner = locked.find((candidate) => ownerIds.has(candidate.id));
    if (
      ownerIds.size !== 1 ||
      !owner ||
      owner.source !== source ||
      owner.identityKind !== "unproven" ||
      owner.deletedAt ||
      owner.withdrawnAt ||
      owner.supersededByOccurrenceId ||
      owner.lastObservedAt > observedAt ||
      prior.length !== 1 ||
      ownerSizes.get(owner.id) !== 1 ||
      prior.some((record) => {
        const claims = providerIdentityClaims(
          z.json().parse(record.providerData),
        );
        return (
          record.deletedAt !== null ||
          claims.malformed ||
          claims.providerIds.some((id) => id !== identity.providerId) ||
          claims.accounts.some((id) => id !== row.row.providerAccountId) ||
          String(record.amount) !==
            String(moneyToMinor(-row.row.providerAmount)) ||
          record.providerAccountId !== row.row.providerAccountId
        );
      })
    )
      return [];
    targets.set(owner.id, (targets.get(owner.id) ?? 0) + 1);
    return [{ key: row.key, identity, owner }];
  });
  for (const { key, identity, owner } of plans) {
    if (targets.get(owner.id) !== 1) continue;
    adopted.set(key, {
      ...owner,
      identityKind: "provider",
      identityScope: identity.scope,
      providerIdentity: identity.providerId,
      identityProof: {
        kind: "raw_provider_ids",
        source,
        account: identity.scope.slice("provider-account:".length),
        provider: identity.providerId!,
        originalIdentityProof: owner.identityProof,
      },
      reviewState: "ready",
    });
  }
  return adopted;
}

export function planSourceIntake({
  prepared,
  members,
  byKey,
  retained,
  existingBatch,
  observedAt,
}: {
  prepared: SourceIntakePrepared;
  members: Member[];
  byKey: Map<string, Owner>;
  retained: Observation[];
  existingBatch: typeof transactionImport.$inferSelect | undefined;
  observedAt: Date;
}) {
  const chosen = prepared.map((incoming) => {
    // A parser-supplied ordinal cannot retroactively attest an old collection.
    // Refuse even an ignored twin before a new occurrence could authorize money.
    if (
      (incoming.identity?.kind === "positioned" ||
        incoming.identity?.kind === "provider") &&
      members.some(
        (member) =>
          member.membership.rowPosition === null &&
          (member.observation.factFingerprint === incoming.factFingerprint ||
            member.legacyAlias === incoming.legacyExternalId),
      )
    )
      constraintViolation(
        "A retained collection has unpositioned evidence; replay cannot attest a new physical position. Retain the original observation and its decisions.",
      );
    if (incoming.identity === null) {
      const retainedMembers = members.filter(
        (member) =>
          member.observation.factFingerprint === incoming.factFingerprint &&
          (member.membership.requestFingerprint === null ||
            member.membership.requestFingerprint ===
              incoming.requestFingerprint),
      );
      if (retainedMembers.length !== 1)
        constraintViolation(
          "New evidence needs attested provider/account IDs or its original physical collection position. A historical replay must identify exactly one retained collection member.",
        );
      const member = retainedMembers[0]!;
      if (member.observation.deletedAt !== null)
        constraintViolation(
          "A tombstoned historical observation cannot be revived by replay.",
        );
      return {
        incoming,
        owner: undefined,
        observation: member.observation,
        member,
      };
    }
    const owner = byKey.get(incoming.key);
    if (owner?.deletedAt)
      constraintViolation(
        "A tombstoned source identity remains reserved and cannot be silently revived.",
      );
    const positionMember =
      incoming.row.rowPosition === undefined
        ? undefined
        : members.find(
            (member) =>
              member.membership.rowPosition === incoming.row.rowPosition,
          );
    const providerMember = owner
      ? members.find((member) => member.observation.occurrenceId === owner.id)
      : undefined;
    const member = positionMember ?? providerMember;
    if (
      member &&
      (member.observation.factFingerprint !== incoming.factFingerprint ||
        (member.membership.requestFingerprint !== null &&
          member.membership.requestFingerprint !==
            incoming.requestFingerprint) ||
        member.observation.occurrenceId !== (owner?.id ?? null) ||
        !owner ||
        (member.membership.rowPosition !== null &&
          incoming.row.rowPosition !== undefined &&
          member.membership.rowPosition !== incoming.row.rowPosition))
    )
      constraintViolation(
        "A retained collection position or provider identity cannot change its original observation facts.",
      );
    if (member?.observation.deletedAt)
      constraintViolation(
        "A retained collection observation is tombstoned; replay cannot replace it.",
      );
    if (member)
      return { incoming, owner, observation: member.observation, member };
    if (owner?.supersededByOccurrenceId)
      constraintViolation(
        "New collection evidence cannot revive a replaced source occurrence.",
      );
    const current = owner
      ? retained.find(
          (saved) =>
            saved.id === owner.currentObservationId &&
            saved.factFingerprint === incoming.factFingerprint &&
            saved.deletedAt === null,
        )
      : undefined;
    const observation =
      current ??
      (owner
        ? retained.find(
            (saved) =>
              saved.occurrenceId === owner.id &&
              saved.factFingerprint === incoming.factFingerprint &&
              saved.deletedAt === null,
          )
        : undefined);
    if (
      owner?.identityKind === "positioned" &&
      retained.some(
        (saved) =>
          saved.occurrenceId === owner.id &&
          saved.factFingerprint !== incoming.factFingerprint,
      )
    )
      constraintViolation(
        "A positioned occurrence cannot change the frozen facts of its original collection row.",
      );
    return { incoming, owner, observation, member: undefined };
  });
  if (existingBatch?.completedAt && chosen.some((row) => !row.member))
    constraintViolation(
      "A completed collection cannot admit additional observations.",
    );
  const novel = chosen.filter((row) => !row.observation);
  const revised = chosen.filter(
    (row) =>
      row.owner &&
      row.owner.currentObservationId &&
      row.observation?.id !== row.owner.currentObservationId,
  );
  const refreshed = chosen.filter(
    (row) =>
      row.owner &&
      row.observation?.id === row.owner.currentObservationId &&
      row.owner.lastObservedAt < observedAt,
  );
  return { chosen, novel, revised, refreshed };
}

type Chosen = ReturnType<typeof planSourceIntake>["chosen"];
export function planSourceHeads({
  chosen,
  byKey,
  createdObservations,
  retained,
  adopted,
  overlapKeys,
  observedAt,
}: {
  chosen: Chosen;
  byKey: Map<string, Owner>;
  createdObservations: Observation[];
  retained: Observation[];
  adopted: Map<string, Owner>;
  overlapKeys: Set<string>;
  observedAt: Date;
}) {
  const headChanges = chosen.flatMap((row) => {
    const owner = byKey.get(row.incoming.key);
    if (!owner || row.member) return [];
    const observation =
      row.observation ??
      createdObservations.find(
        (saved) =>
          saved.occurrenceId === owner.id &&
          saved.factFingerprint === row.incoming.factFingerprint,
      )!;
    const differentFacts =
      owner.currentObservationId !== null &&
      owner.currentObservationId !== observation.id &&
      retained.find((saved) => saved.id === owner.currentObservationId)
        ?.factFingerprint !== row.incoming.factFingerprint;
    const adoption = adopted.has(row.incoming.key);
    // Adoption proves identity, not revision order: differing facts wait
    // for the same head review as any provider owner.
    const currentObservationId = adoption
      ? differentFacts
        ? null
        : observation.id
      : !row.owner
        ? observation.id
        : differentFacts &&
            owner.withdrawnAt === null &&
            owner.reviewState === "ready"
          ? null
          : owner.currentObservationId;
    const failedProviderProof =
      !!row.incoming.row.providerTransactionId &&
      row.incoming.identity?.kind !== "provider";
    const reviewState = adoption
      ? differentFacts
        ? "revision_order_unknown"
        : owner.reviewState
      : owner.reviewState !== "ready" &&
          owner.reviewState !== "revision_order_unknown"
        ? owner.reviewState
        : overlapKeys.has(row.incoming.key) || failedProviderProof
          ? "identity_conflict"
          : owner.withdrawnAt !== null && observedAt > owner.withdrawnAt
            ? "reappeared"
            : differentFacts && owner.reviewState === "ready"
              ? "revision_order_unknown"
              : owner.reviewState;
    const semantic =
      adoption ||
      (row.owner !== undefined &&
        (currentObservationId !== owner.currentObservationId ||
          reviewState !== owner.reviewState));
    const lastObservedAt =
      owner.lastObservedAt < observedAt ? observedAt : owner.lastObservedAt;
    if (
      row.owner &&
      !semantic &&
      lastObservedAt.getTime() === owner.lastObservedAt.getTime()
    )
      return [];
    return [
      {
        id: owner.id,
        currentObservationId,
        reviewState,
        lastObservedAt,
        version: owner.version + (semantic ? 1 : 0),
      },
    ];
  });
  return headChanges;
}

export function planIntakeReceipt(
  input: RecordSourceTransactionRecordsInput,
  loaded: SourceIntakeLoaded,
  plan: ReturnType<typeof planSourceIntake>,
) {
  const { existingBatch, members } = loaded;
  const { chosen, novel, revised, refreshed } = plan;
  const occurrenceCodes: string[] = [];
  const base = {
    batchId: existingBatch?.id ?? null,
    batchCreated: false,
    dryRun: input.dryRun,
    inserted: novel.length,
    unchanged: chosen.length - novel.length,
    alreadyInThisBatch: chosen.filter((row) => row.member).length,
    alreadyInAnotherBatch: chosen.filter(
      (row) => row.observation && !row.member,
    ).length,
    rowCountStored: members.length,
    completed:
      existingBatch?.completedAt !== null && existingBatch !== undefined,
    revised: revised.length,
    refreshed: refreshed.length,
    withdrawn: 0,
    correctionReviews: [],
    occurrenceCodes,
    signWarning: statementSignWarning(input.rows),
  };
  return base;
}

function statementSignWarning(
  rows: ReadonlyArray<{ providerAmount: number }>,
): string | null {
  const positive = rows.filter((row) => row.providerAmount > 0).length;
  return rows.length >= 20 && positive / rows.length > 0.9
    ? `${positive} of ${rows.length} rows have a positive providerAmount. Charges must be submitted negative; check the export sign convention. Legitimate if this collection is income or refunds.`
    : null;
}

export function planWithdrawals(
  input: RecordSourceTransactionRecordsInput,
  loaded: SourceIntakeLoaded,
  plan: ReturnType<typeof planSourceIntake>,
  completed: boolean,
  rowCountStored: number,
) {
  if (!input.confirmedWithdrawals.length) return [];
  const { source, locked, retained, observedAt } = loaded;
  const { chosen } = plan;
  const coverage = input.import.coverage;
  if (
    !completed ||
    !coverage ||
    coverage.visibility !== "all" ||
    input.import.rowCountDeclared !== rowCountStored
  )
    return constraintViolation(
      "Withdrawals require a completed, exhaustive rechecked account window.",
    );
  const withdrawals = locked.filter(
    (owner) =>
      owner.source === source &&
      owner.identityKind === "provider" &&
      owner.identityScope === `provider-account:${coverage.account}` &&
      input.confirmedWithdrawals.includes(owner.providerIdentity!),
  );
  if (withdrawals.length !== input.confirmedWithdrawals.length)
    constraintViolation(
      "Every confirmed withdrawal must identify a retained occurrence in the proven account scope.",
    );
  for (const owner of withdrawals) {
    const head = retained.find((row) => row.id === owner.currentObservationId);
    if (
      !head ||
      head.statementDate < coverage.from ||
      head.statementDate > coverage.to ||
      owner.lastObservedAt > observedAt ||
      chosen.some((row) => row.owner?.id === owner.id)
    )
      constraintViolation(
        "The confirmed removal is observed, newer, unresolved, or outside the collection scope.",
      );
  }
  return withdrawals.filter((owner) => owner.withdrawnAt === null);
}
