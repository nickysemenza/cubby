import { entityRefKey } from "@cubby/schemas/entity";
import { toPublicImpact } from "@cubby/schemas/entity-integrity";
import type { ExpenseId, LedgerTransferId } from "@cubby/schemas/identifiers";
import {
  ledgerSourceClaimNormalizedEvidence,
  type LedgerSourceClaimInput,
} from "@cubby/schemas/ledger-transfer";
import { and, eq, inArray } from "drizzle-orm";
import { isEqual } from "es-toolkit";

import type { DrizzleTransaction } from "~/server/db";
import { ledgerSourceClaim } from "~/server/db/schema";
import { createAppError, createBlockedError } from "~/server/errors/app-error";
import { notDeleted } from "~/server/repo/database-helpers";
import { ensureExternalSources } from "~/server/repo/entity-external-ids";
import { lookupShortcodes } from "~/server/repo/shortcode-resolver";

const SOURCE_KEY_VERSION = 1;

const toHex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const digestKey = async (payload: readonly unknown[]) =>
  `v${SOURCE_KEY_VERSION}:${toHex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  )}`;

// The evidence is hashed in `ledgerSourceClaimNormalizedEvidence` key order, the
// order it had when the key was first made; a stored jsonb value is reordered.
const evidenceKey = (
  source: string,
  evidence: LedgerSourceClaimInput["normalizedEvidence"],
) =>
  digestKey([
    SOURCE_KEY_VERSION,
    source,
    ledgerSourceClaimNormalizedEvidence.parse(evidence),
  ]);

type ResolvedKey = { key: string; version: number };

async function newClaimKey(
  claim: LedgerSourceClaimInput,
): Promise<ResolvedKey> {
  // Provider identities are stable, but still external identifiers: hash the
  // source namespace and provider id rather than storing either in sourceKey.
  const key = claim.providerId
    ? await digestKey([
        SOURCE_KEY_VERSION,
        claim.source,
        "provider",
        claim.providerId,
      ])
    : await evidenceKey(claim.source, claim.normalizedEvidence);
  return { key, version: SOURCE_KEY_VERSION };
}

type ClaimOwner =
  | {
      expenseId: ExpenseId;
      ledgerTransferId?: never;
      targetAmount: number | null;
    }
  | {
      ledgerTransferId: LedgerTransferId;
      expenseId?: never;
      targetAmount: number;
    };

type ClaimOwnerReference =
  | { expenseId: ExpenseId; ledgerTransferId?: never }
  | { ledgerTransferId: LedgerTransferId; expenseId?: never };

const isExpenseOwner = (
  owner: ClaimOwner | ClaimOwnerReference,
): owner is Extract<
  ClaimOwner | ClaimOwnerReference,
  { expenseId: ExpenseId }
> => owner.expenseId !== undefined;

const sameAmount = (left: number | null, right: number | null) =>
  left === null || right === null
    ? left === right
    : Math.round(left * 100) === Math.round(right * 100);

const assertClaimAmounts = (
  targetAmount: number | null,
  claims: readonly LedgerSourceClaimInput[],
): void => {
  if (targetAmount === null && claims.length > 0) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "An Expense needs a cost before it can claim normalized source evidence.",
    );
  }
  for (const claim of claims) {
    const matches = sameAmount(claim.normalizedEvidence.amount, targetAmount);
    if ((claim.reconciliation.decision === "amounts_match") === matches) {
      continue;
    }
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      matches
        ? "Matching source and target amounts require the amounts_match decision."
        : "A source/target amount mismatch requires accept_target_amount with a note.",
    );
  }
};

/**
 * A claim's reconciliation decision is about the target amount captured when
 * the claim was made. Once that amount changes, omission cannot mean "leave
 * the nested set alone": doing so would preserve a stale amounts_match (or a
 * stale reviewed mismatch). The caller must replace or clear the claims.
 */
export async function assertExplicitSourceClaimsForAmountChange(
  tx: DrizzleTransaction,
  owner: ClaimOwnerReference,
  previousAmount: number | null,
  nextAmount: number | null,
  sourceClaims: readonly LedgerSourceClaimInput[] | null | undefined,
): Promise<void> {
  if (sourceClaims !== undefined || sameAmount(previousAmount, nextAmount))
    return;

  const [claim] = await tx
    .select({ id: ledgerSourceClaim.id })
    .from(ledgerSourceClaim)
    .where(and(ownerClaims(owner), notDeleted(ledgerSourceClaim)))
    .limit(1);
  if (!claim) return;

  const target = isExpenseOwner(owner) ? "Expense cost" : "transfer amount";
  throw createAppError(
    "CONSTRAINT_VIOLATION",
    `Changing the ${target} while source claims exist requires sourceClaims to be replaced or cleared explicitly.`,
  );
}

const ownerClaims = (owner: ClaimOwnerReference) =>
  isExpenseOwner(owner)
    ? eq(ledgerSourceClaim.expenseId, owner.expenseId)
    : eq(ledgerSourceClaim.ledgerTransferId, owner.ledgerTransferId);

/**
 * A claim sent with a `sourceKey` is an edit of a claim this record already
 * holds. The key is a hash, so whether it came from a provider id or from the
 * evidence is recovered by re-hashing the stored evidence: if that reproduces
 * the stored key the claim is evidence-keyed, and an evidence edit re-hashes it
 * to its new key in this one replacement (the old row retires with it);
 * otherwise it is provider-keyed and keeps its key through an evidence edit, so
 * the provider id still resolves to this claim. A key the record does not hold
 * is refused (it could otherwise adopt another record's, or a retired,
 * identity). A kept key keeps the stored row's `sourceKeyVersion`.
 */
async function resolveClaimKeys(
  tx: DrizzleTransaction,
  owner: ClaimOwnerReference,
  claims: readonly LedgerSourceClaimInput[],
): Promise<ResolvedKey[]> {
  const held = claims.some((claim) => claim.sourceKey !== undefined)
    ? await tx
        .select({
          source: ledgerSourceClaim.source,
          sourceKey: ledgerSourceClaim.sourceKey,
          sourceKeyVersion: ledgerSourceClaim.sourceKeyVersion,
          normalizedEvidence: ledgerSourceClaim.normalizedEvidence,
        })
        .from(ledgerSourceClaim)
        .where(and(ownerClaims(owner), notDeleted(ledgerSourceClaim)))
    : [];
  const resolved = await Promise.all(
    claims.map(async (claim): Promise<ResolvedKey> => {
      if (claim.sourceKey === undefined) return newClaimKey(claim);
      const row = held.find(
        (candidate) =>
          candidate.source === claim.source &&
          candidate.sourceKey === claim.sourceKey,
      );
      if (!row)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Source claim identity ${claim.source}/${claim.sourceKey} is not held by this record. Send a new claim without sourceKey instead.`,
        );
      const kept = { key: row.sourceKey, version: row.sourceKeyVersion };
      if (isEqual(row.normalizedEvidence, claim.normalizedEvidence))
        return kept;
      const evidenceKeyed =
        row.sourceKeyVersion === SOURCE_KEY_VERSION &&
        (await evidenceKey(row.source, row.normalizedEvidence)) ===
          row.sourceKey;
      return evidenceKeyed
        ? {
            key: await evidenceKey(claim.source, claim.normalizedEvidence),
            version: SOURCE_KEY_VERSION,
          }
        : kept;
    }),
  );
  const seen = new Set<string>();
  for (const [index, { key }] of resolved.entries()) {
    const id = `${claims[index]!.source}\0${key}`;
    if (seen.has(id))
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Source claims must not repeat an identity: ${claims[index]!.source}/${key}.`,
      );
    seen.add(id);
  }
  return resolved;
}

export async function replaceLedgerSourceClaims(
  tx: DrizzleTransaction,
  owner: ClaimOwner,
  claims: readonly LedgerSourceClaimInput[],
): Promise<void> {
  const { targetAmount } = owner;
  const keys = await resolveClaimKeys(tx, owner, claims);
  assertClaimAmounts(targetAmount, claims);
  const valuesFor = (
    claim: LedgerSourceClaimInput,
    { key, version }: ResolvedKey,
  ) => ({
    expenseId: isExpenseOwner(owner) ? owner.expenseId : null,
    ledgerTransferId: isExpenseOwner(owner) ? null : owner.ledgerTransferId,
    source: claim.source,
    sourceKey: key,
    sourceKeyVersion: version,
    normalizedEvidence: claim.normalizedEvidence,
    targetAmountAtClaim: targetAmount!,
    reconciliationDecision: claim.reconciliation.decision,
    reconciliationNote:
      claim.reconciliation.decision === "accept_target_amount"
        ? claim.reconciliation.note
        : null,
    deletedAt: null,
  });

  // Reserve every canonical identity before reading its owner. A conflicting
  // insert waits for an in-flight first claim, then SELECT FOR UPDATE locks the
  // winner (or the shared tombstone) without touching updatedAt. Sorting
  // prevents replacement sets with reversed input order from deadlocking.
  // This makes both first claims and tombstone revival serialize without
  // advisory importer locks while preserving exact-retry audit idempotency.
  const reservations = claims
    .map((claim, index) => valuesFor(claim, keys[index]!))
    .sort((left, right) =>
      `${left.source}\0${left.sourceKey}`.localeCompare(
        `${right.source}\0${right.sourceKey}`,
      ),
    );
  // Every `source` names a registered ExternalSource (FK).
  await ensureExternalSources(
    tx,
    reservations.map((values) => values.source),
  );
  const existing: (typeof ledgerSourceClaim.$inferSelect)[] = [];
  for (const values of reservations) {
    await tx
      .insert(ledgerSourceClaim)
      .values(values)
      .onConflictDoNothing({
        target: [ledgerSourceClaim.source, ledgerSourceClaim.sourceKey],
      });
    const [reserved] = await tx
      .select()
      // includes-deleted: the unique source identity deliberately reserves its
      // tombstone so one corrected owner can revive it without a steal race.
      .from(ledgerSourceClaim)
      .where(
        and(
          eq(ledgerSourceClaim.source, values.source),
          eq(ledgerSourceClaim.sourceKey, values.sourceKey),
        ),
      )
      .for("update")
      .limit(1);
    if (!reserved)
      throw new Error("A reserved ledger source claim could not be read back.");
    existing.push(reserved);
  }
  const own = (row: (typeof existing)[number]) =>
    isExpenseOwner(owner)
      ? row.expenseId === owner.expenseId && row.ledgerTransferId === null
      : row.ledgerTransferId === owner.ledgerTransferId &&
        row.expenseId === null;
  const conflicting = existing.filter(
    (row) => !own(row) && row.deletedAt === null,
  );
  if (conflicting.length > 0) {
    const owners = conflicting.map((row) =>
      row.expenseId
        ? { entity: "expense" as const, id: row.expenseId }
        : { entity: "ledgerTransfer" as const, id: row.ledgerTransferId! },
    );
    const shortcodes = await lookupShortcodes(tx, owners);
    const publicIdByOwnerId = new Map(
      owners.flatMap((owner) => {
        const shortcode = shortcodes.get(entityRefKey(owner.entity, owner.id));
        return shortcode ? [[owner.id, shortcode] as const] : [];
      }),
    );
    const byTargetId = Object.fromEntries(
      owners.map(({ id }) => [
        id,
        owners.filter((owner) => owner.id === id).length,
      ]),
    );
    const blocker = toPublicImpact(
      {
        code: "source-claim-already-owned",
        effect: "block",
        label: "source claim owner",
        description:
          "An active ledger record already owns one or more requested source claims.",
        total: conflicting.length,
        byTargetId,
      },
      publicIdByOwnerId,
      "throw",
    );
    throw createBlockedError(
      "LEDGER_SOURCE_CLAIM_CONFLICT",
      "A source claim is already attached to a different ledger record.",
      [blocker],
    );
  }
  const currentOwner = ownerClaims(owner);
  const currentRows = await tx
    .select({
      id: ledgerSourceClaim.id,
      source: ledgerSourceClaim.source,
      sourceKey: ledgerSourceClaim.sourceKey,
    })
    .from(ledgerSourceClaim)
    .where(and(currentOwner, notDeleted(ledgerSourceClaim)));
  const wanted = new Set(
    claims.map((claim, index) => `${claim.source}\0${keys[index]!.key}`),
  );
  const retired = currentRows
    .filter((row) => !wanted.has(`${row.source}\0${row.sourceKey}`))
    .map((row) => row.id);
  if (retired.length)
    await tx
      .update(ledgerSourceClaim)
      .set({ deletedAt: new Date() })
      .where(inArray(ledgerSourceClaim.id, retired));
  for (const [index, claim] of claims.entries()) {
    const resolved = keys[index]!;
    const key = resolved.key;
    const row = existing.find(
      (candidate) =>
        candidate.source === claim.source && candidate.sourceKey === key,
    );
    // A released tombstone can be claimed by either owner kind. Set both
    // sides, rather than spreading a partial owner, so the XOR check holds.
    const values = valuesFor(claim, resolved);
    const unchanged =
      row !== undefined &&
      own(row) &&
      row.deletedAt === null &&
      row.sourceKeyVersion === values.sourceKeyVersion &&
      isEqual(row.normalizedEvidence, values.normalizedEvidence) &&
      Math.round(row.targetAmountAtClaim * 100) ===
        Math.round(values.targetAmountAtClaim * 100) &&
      row.reconciliationDecision === values.reconciliationDecision &&
      row.reconciliationNote === values.reconciliationNote;
    if (unchanged) continue;
    if (row)
      await tx
        .update(ledgerSourceClaim)
        .set(values)
        .where(eq(ledgerSourceClaim.id, row.id));
    else await tx.insert(ledgerSourceClaim).values(values);
  }
}
