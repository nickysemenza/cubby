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

/**
 * Source intake is two steps: `planSourceIntake` turns the locked rows and the
 * request into this closed list of writes, and `applySourceIntake` executes it
 * and reads nothing else. Rows the database has not minted yet are named by
 * reference and resolved while the writes run.
 */
type Owner = typeof sourceOccurrence.$inferSelect;
type Observation = typeof sourceTransactionRecord.$inferSelect;
type Batch = typeof transactionImport.$inferSelect;
type Member = {
  membership: typeof transactionImportRecord.$inferSelect;
  observation: Observation;
  legacyAlias: string | null;
};
type Row = RecordSourceTransactionRecordsInput["rows"][number];

export type Identity = {
  kind: "provider" | "positioned";
  scope: string;
  providerId: string | null;
  position: number | null;
};

export type PreparedRow = {
  row: Row;
  identity: Identity | null;
  key: string;
  factFingerprint: string;
  requestFingerprint: string;
  externalId: string;
  legacyExternalId: string;
};

export type SourceIntakeLoaded = {
  source: string;
  existingBatch: Batch | undefined;
  observedAt: Date;
  members: Member[];
  byKey: Map<string, Owner>;
  locked: Owner[];
  retained: Observation[];
};

/** A stored occurrence, or one this plan mints, named by its identity key. */
export type OwnerRef =
  | { id: Owner["id"]; shortcode: string }
  | { minted: string };
/** A stored observation, or one this plan mints for an owner and fact set. */
export type ObservationRef =
  | { id: Observation["id"] }
  | { minted: { owner: OwnerRef; factFingerprint: string } };

type BatchValues = Omit<
  RecordSourceTransactionRecordsInput["import"],
  "observedAt" | "coverage"
> & {
  observedAt: Date;
  coverage: RecordSourceTransactionRecordsInput["import"]["coverage"] | null;
};
type OccurrenceValues = Omit<
  typeof sourceOccurrence.$inferInsert,
  "shortcode" | "physicalImportId"
>;
type ObservationValues = Omit<
  typeof sourceTransactionRecord.$inferInsert,
  "shortcode" | "batchId" | "occurrenceId"
>;

type MintedOccurrence = {
  key: string;
  /** A positioned occurrence is physically owned by the batch that carries it. */
  positionedInBatch: boolean;
  values: OccurrenceValues;
};
type MintedObservation = {
  owner: OwnerRef;
  factFingerprint: string;
  values: ObservationValues;
  aliases: {
    externalId: string;
    legacyExternalId: string;
    scopeEvidence: { identityKind: Identity["kind"]; scope: string };
  };
};
type HeadChange = {
  owner: OwnerRef;
  head: ObservationRef | null;
  reviewState: Owner["reviewState"];
  lastObservedAt: Date;
  version: number;
};
type PlannedMembership = {
  observation: ObservationRef;
  rowPosition: number | null;
  requestFingerprint: string;
};

type SourceIntakeWrite =
  | { kind: "ensure_source"; source: string }
  | { kind: "insert_batch"; values: BatchValues }
  | { kind: "insert_occurrences"; rows: MintedOccurrence[] }
  | { kind: "insert_observations"; rows: MintedObservation[] }
  | { kind: "update_heads"; changes: HeadChange[] }
  | { kind: "upsert_memberships"; rows: PlannedMembership[] }
  | { kind: "audit_occurrences"; before: Owner[] }
  | { kind: "audit_new_observations" }
  | { kind: "complete_batch" }
  | { kind: "withdraw_occurrence"; owner: Owner; at: Date }
  | { kind: "record_change" }
  | {
      kind: "audit_batch";
      before: Batch | undefined;
      /** Observations that already belonged to the batch before this request. */
      priorMemberIds: Observation["id"][];
    }
  /** A violated precondition the request reaches only after the writes before it. */
  | { kind: "refuse"; message: string };

type SourceIntakeReceipt = {
  batchId: Batch["id"] | null;
  batchCreated: boolean;
  dryRun: boolean;
  inserted: number;
  unchanged: number;
  alreadyInThisBatch: number;
  alreadyInAnotherBatch: number;
  rowCountStored: number;
  completed: boolean;
  revised: number;
  refreshed: number;
  withdrawn: number;
  occurrenceCodes: string[];
  signWarning: string | null;
};

export type SourceIntakePlan = {
  writes: SourceIntakeWrite[];
  /** What a dry run reports; apply starts from it. */
  receipt: SourceIntakeReceipt;
  /** What a run that reaches the end of `writes` adds to the receipt. */
  outcome: {
    batchCreated: boolean;
    rowCountStored: number;
    completed: boolean;
    withdrawn: number;
    chosenOwners: OwnerRef[];
    withdrawalCodes: string[];
  };
};

type ChosenRow = {
  incoming: PreparedRow;
  owner: Owner | undefined;
  observation: Observation | undefined;
  member: Member | undefined;
};

const reexportedPosition = (
  identity: PreparedRow["identity"],
  owner: Pick<Owner, "identityScope">,
) => identity?.kind === "positioned" && identity.scope !== owner.identityScope;

function chooseRows(
  prepared: PreparedRow[],
  { members, byKey, retained, existingBatch }: SourceIntakeLoaded,
): ChosenRow[] {
  const chosen = prepared.map((incoming): ChosenRow => {
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
  return chosen;
}

const ownerRefOf = (row: ChosenRow): OwnerRef | null =>
  row.owner
    ? { id: row.owner.id, shortcode: row.owner.shortcode }
    : row.incoming.identity
      ? { minted: row.incoming.key }
      : null;

const ownerRefKey = (ref: OwnerRef | null) =>
  ref === null ? null : "minted" in ref ? `minted:${ref.minted}` : ref.id;

const requiredOwner = (row: ChosenRow): OwnerRef =>
  ownerRefOf(row) ??
  constraintViolation("A new observation requires proven source identity.");

const observationRefOf = (row: ChosenRow): ObservationRef =>
  row.observation
    ? { id: row.observation.id }
    : {
        minted: {
          owner: requiredOwner(row),
          factFingerprint: row.incoming.factFingerprint,
        },
      };

const observationRefKey = (ref: ObservationRef) =>
  "id" in ref
    ? ref.id
    : `minted:${ownerRefKey(ref.minted.owner)}|${ref.minted.factFingerprint}`;

/** The columns head selection reads; a minted occurrence starts at the column defaults. */
type HeadState = Pick<
  Owner,
  | "identityScope"
  | "currentObservationId"
  | "reviewState"
  | "withdrawnAt"
  | "lastObservedAt"
  | "version"
> & { id: string };

function planHeads(
  chosen: ChosenRow[],
  retained: Observation[],
  observedAt: Date,
): HeadChange[] {
  // oxlint-disable-next-line complexity -- Head selection combines evidence, ordering, withdrawal and conflict fences.
  return chosen.flatMap((row) => {
    const ownerRef = ownerRefOf(row);
    if (!ownerRef || row.member) return [];
    const owner: HeadState = row.owner ?? {
      id: ownerRefKey(ownerRef)!,
      identityScope: row.incoming.identity!.scope,
      currentObservationId: null,
      reviewState: "ready",
      withdrawnAt: null,
      lastObservedAt: observedAt,
      version: 1,
    };
    const observation = observationRefOf(row);
    const observationId = "id" in observation ? observation.id : undefined;
    const differentFacts =
      owner.currentObservationId !== null &&
      owner.currentObservationId !== observationId &&
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
    const head: ObservationRef | null = !row.owner
      ? observation
      : orderedRevision ||
          (reexportedPosition(row.incoming.identity, owner) &&
            !differentFacts &&
            observedAt > owner.lastObservedAt)
        ? observation
        : differentFacts &&
            !annotationsOnly &&
            owner.withdrawnAt === null &&
            owner.reviewState === "ready"
          ? null
          : owner.currentObservationId === null
            ? null
            : { id: owner.currentObservationId };
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
    const headId = head === null ? null : "id" in head ? head.id : undefined;
    const semantic =
      row.owner !== undefined &&
      (headId !== owner.currentObservationId ||
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
        owner: ownerRef,
        head,
        reviewState,
        lastObservedAt,
        version: owner.version + (semantic ? 1 : 0),
      },
    ];
  });
}

function statementSignWarning(
  rows: ReadonlyArray<{ providerAmount: number }>,
): string | null {
  const positive = rows.filter((row) => row.providerAmount > 0).length;
  return rows.length >= 20 && positive / rows.length > 0.9
    ? `${positive} of ${rows.length} rows have a positive providerAmount. Charges must be submitted negative; check the export sign convention. Legitimate if this collection is income or refunds.`
    : null;
}

function planWithdrawals(
  input: RecordSourceTransactionRecordsInput,
  { source, locked, retained, observedAt }: SourceIntakeLoaded,
  chosen: ChosenRow[],
  completed: boolean,
  rowCountStored: number,
): { refusal: string } | { owners: Owner[] } {
  if (!input.confirmedWithdrawals.length) return { owners: [] };
  const coverage = input.import.coverage;
  if (
    !completed ||
    !coverage ||
    coverage.visibility !== "all" ||
    input.import.rowCountDeclared !== rowCountStored
  )
    return {
      refusal:
        "Withdrawals require a completed, exhaustive rechecked account window.",
    };
  const withdrawals = locked.filter(
    (owner) =>
      owner.source === source &&
      owner.identityKind === "provider" &&
      input.confirmedWithdrawals.includes(owner.providerIdentity!),
  );
  if (withdrawals.length !== input.confirmedWithdrawals.length)
    return {
      refusal:
        "Every confirmed withdrawal must identify a retained occurrence in the proven account scope.",
    };
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
      return {
        refusal:
          "The confirmed removal is observed, newer, unresolved, or outside the collection scope.",
      };
  }
  return { owners: withdrawals.filter((owner) => owner.withdrawnAt === null) };
}

/** Intake changes evidence/head state only. Unknown revision order never changes accepted money. */
export function planSourceIntake(
  input: RecordSourceTransactionRecordsInput,
  prepared: PreparedRow[],
  loaded: SourceIntakeLoaded,
): SourceIntakePlan {
  const { source, existingBatch, observedAt, members, byKey, locked } = loaded;
  const chosen = chooseRows(prepared, loaded);
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
  const receipt: SourceIntakeReceipt = {
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
    occurrenceCodes: [],
    signWarning: statementSignWarning(input.rows),
  };

  /** The occurrence a prepared row lands on, whether stored or minted by this plan. */
  const preparedOwnerKey = (candidate: PreparedRow) =>
    byKey.get(candidate.key)?.id ??
    (candidate.identity ? `minted:${candidate.key}` : null);
  const writes: SourceIntakeWrite[] = [{ kind: "ensure_source", source }];
  if (!existingBatch)
    writes.push({
      kind: "insert_batch",
      values: {
        ...input.import,
        observedAt,
        coverage: input.import.coverage ?? null,
      },
    });
  const fresh = chosen.filter(
    (row) => !row.owner && row.incoming.identity !== null,
  );
  if (fresh.length)
    writes.push({
      kind: "insert_occurrences",
      rows: fresh.map(({ incoming }) => {
        const identity = incoming.identity!;
        return {
          key: incoming.key,
          positionedInBatch: identity.kind === "positioned",
          values: {
            source,
            identityKind: identity.kind,
            identityScope: identity.scope,
            providerIdentity: identity.providerId,
            physicalPosition: identity.position,
            identityProof:
              identity.kind === "provider"
                ? {
                    kind: "raw_provider_ids",
                    source,
                    account: incoming.row.providerAccountId ?? null,
                    provider: identity.providerId!,
                  }
                : {
                    kind: "original_collection_position",
                    source,
                    fingerprint: input.import.fingerprint,
                    position: identity.position!,
                  },
            reviewState: "ready",
            version: 1,
            lastObservedAt: observedAt,
          },
        };
      }),
    });
  if (novel.length)
    writes.push({
      kind: "insert_observations",
      rows: novel.map((row) => {
        const { incoming } = row;
        const owner = requiredOwner(row);
        // Every observation of one occurrence and fact set shares the first prepared row's aliases.
        const aliasSource =
          prepared.find(
            (candidate) =>
              preparedOwnerKey(candidate) === ownerRefKey(owner) &&
              candidate.factFingerprint === incoming.factFingerprint,
          ) ?? incoming;
        const identity =
          aliasSource.identity ??
          constraintViolation(
            "A new observation requires proven source identity.",
          );
        return {
          owner,
          factFingerprint: incoming.factFingerprint,
          values: {
            ...incoming.row,
            source,
            factFingerprint: incoming.factFingerprint,
            providerTransactionId: incoming.row.providerTransactionId ?? null,
            providerAccountId: incoming.row.providerAccountId ?? null,
            providerData: incoming.row.providerData ?? null,
            amount: moneyToMinor(-incoming.row.providerAmount),
            providerAmount: moneyToMinor(incoming.row.providerAmount),
          },
          aliases: {
            externalId: aliasSource.externalId,
            legacyExternalId: aliasSource.legacyExternalId,
            scopeEvidence: {
              identityKind: identity.kind,
              scope: identity.scope,
            },
          },
        };
      }),
    });
  const headChanges = planHeads(chosen, loaded.retained, observedAt);
  if (headChanges.length)
    writes.push({ kind: "update_heads", changes: headChanges });
  const memberships = chosen.map((row): PlannedMembership => ({
    observation: observationRefOf(row),
    rowPosition: row.incoming.row.rowPosition ?? null,
    requestFingerprint: row.incoming.requestFingerprint,
  }));
  if (memberships.length)
    writes.push({ kind: "upsert_memberships", rows: memberships });
  writes.push({ kind: "audit_occurrences", before: locked });
  if (novel.length) writes.push({ kind: "audit_new_observations" });

  const priorMemberIds = members.map(
    (member) => member.membership.statementRowId,
  );
  const rowCountStored = new Set([
    ...priorMemberIds,
    ...memberships.map((membership) =>
      observationRefKey(membership.observation),
    ),
  ]).size;
  const chosenOwners = chosen.flatMap((row) => {
    const owner = ownerRefOf(row);
    return owner ? [owner] : [];
  });
  const withdrawalCodes = locked
    .filter((owner) =>
      input.confirmedWithdrawals.includes(owner.providerIdentity ?? ""),
    )
    .map((owner) => owner.shortcode);
  const outcome = {
    batchCreated: !existingBatch,
    rowCountStored,
    completed:
      existingBatch?.completedAt !== null && existingBatch !== undefined,
    withdrawn: 0,
    chosenOwners,
    withdrawalCodes,
  };
  const plan = { writes, receipt, outcome };
  if (input.complete && !outcome.completed) {
    if (
      !input.import.coverage ||
      input.import.rowCountDeclared === null ||
      input.import.rowCountDeclared !== rowCountStored
    ) {
      writes.push({
        kind: "refuse",
        message:
          "Completion requires explicit coverage and every declared occurrence, including zero values.",
      });
      return plan;
    }
    writes.push({ kind: "complete_batch" });
    outcome.completed = true;
  }
  const withdrawals = planWithdrawals(
    input,
    loaded,
    chosen,
    outcome.completed,
    rowCountStored,
  );
  if ("refusal" in withdrawals) {
    writes.push({ kind: "refuse", message: withdrawals.refusal });
    return plan;
  }
  for (const owner of withdrawals.owners)
    writes.push({ kind: "withdraw_occurrence", owner, at: observedAt });
  outcome.withdrawn = withdrawals.owners.length;
  if (novel.length || headChanges.length || outcome.withdrawn)
    writes.push({ kind: "record_change" });
  writes.push({ kind: "audit_batch", before: existingBatch, priorMemberIds });
  return plan;
}
