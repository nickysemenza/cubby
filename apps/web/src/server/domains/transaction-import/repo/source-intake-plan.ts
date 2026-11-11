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
type Owner = typeof sourceOccurrence.$inferSelect;
type Observation = typeof sourceTransactionRecord.$inferSelect;
type Member = {
  membership: typeof transactionImportRecord.$inferSelect;
  observation: Observation;
  legacyAlias: string | null;
};
const reexportedPosition = (
  identity: SourceIntakePrepared[number]["identity"],
  owner: Owner,
) => identity?.kind === "positioned" && identity.scope !== owner.identityScope;

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
      incoming.identity?.kind === "positioned" &&
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
    const reexport =
      incoming.identity.kind === "positioned" &&
      owner &&
      owner.identityScope !== incoming.identity.scope;
    const observation = reexport
      ? undefined
      : (current ??
        (owner
          ? retained.find(
              (saved) =>
                saved.occurrenceId === owner.id &&
                saved.factFingerprint === incoming.factFingerprint &&
                saved.deletedAt === null,
            )
          : undefined));
    if (
      owner?.identityKind === "positioned" &&
      owner.identityScope === incoming.identity.scope &&
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
  observedAt,
}: {
  chosen: Chosen;
  byKey: Map<string, Owner>;
  createdObservations: Observation[];
  retained: Observation[];
  observedAt: Date;
}) {
  // oxlint-disable-next-line complexity -- Head selection combines evidence, ordering, withdrawal and conflict fences.
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
    const current = retained.find(
      (saved) => saved.id === owner.currentObservationId,
    );
    const claims = providerIdentityClaims(row.incoming.row.providerData);
    const account =
      row.incoming.row.providerAccountId ?? claims.accounts[0] ?? null;
    const identityConflict =
      row.incoming.identity?.kind === "provider" &&
      (claims.malformed ||
        new Set(claims.accounts).size > 1 ||
        claims.providerIds.some(
          (id) => id !== row.incoming.row.providerTransactionId,
        ) ||
        claims.accounts.some((id) => account != null && id !== account) ||
        (account != null &&
          retained.some(
            (saved) =>
              saved.occurrenceId === owner.id &&
              [
                saved.providerAccountId,
                ...providerIdentityClaims(z.json().parse(saved.providerData))
                  .accounts,
              ].some((id) => id != null && id !== account),
          )));
    const annotationsOnly =
      row.incoming.identity?.kind === "provider" &&
      current &&
      String(current.amount) ===
        String(moneyToMinor(-row.incoming.row.providerAmount)) &&
      current.statementDate === row.incoming.row.statementDate &&
      current.rawDescription === row.incoming.row.rawDescription &&
      current.accountDescriptor === row.incoming.row.accountDescriptor &&
      (current.providerAccountId == null ||
        account == null ||
        current.providerAccountId === account);
    const orderedRevision =
      differentFacts && annotationsOnly && observedAt > owner.lastObservedAt;
    const currentObservationId = !row.owner
      ? observation.id
      : orderedRevision ||
          (reexportedPosition(row.incoming.identity, owner) &&
            !differentFacts &&
            observedAt > owner.lastObservedAt)
        ? observation.id
        : differentFacts &&
            !annotationsOnly &&
            owner.withdrawnAt === null &&
            owner.reviewState === "ready"
          ? null
          : owner.currentObservationId;
    const reviewState =
      owner.reviewState !== "ready" &&
      owner.reviewState !== "revision_order_unknown"
        ? owner.reviewState
        : identityConflict
          ? "identity_conflict"
          : owner.withdrawnAt !== null && observedAt > owner.withdrawnAt
            ? "reappeared"
            : differentFacts &&
                !annotationsOnly &&
                owner.reviewState === "ready"
              ? "revision_order_unknown"
              : owner.reviewState;
    const semantic =
      row.owner !== undefined &&
      (currentObservationId !== owner.currentObservationId ||
        reviewState !== owner.reviewState);
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
      input.confirmedWithdrawals.includes(owner.providerIdentity!),
  );
  if (withdrawals.length !== input.confirmedWithdrawals.length)
    constraintViolation(
      "Every confirmed withdrawal must identify a retained occurrence in the proven account scope.",
    );
  for (const owner of withdrawals) {
    const head = retained.find((row) => row.id === owner.currentObservationId);
    // A provider id is unique without its account; a missing account is not another account.
    if (
      !head ||
      (head.providerAccountId !== null &&
        head.providerAccountId !== coverage.account) ||
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
