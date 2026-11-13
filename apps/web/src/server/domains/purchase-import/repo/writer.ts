import {
  parseEntityId,
  userId as userIdSchema,
  runEntityId,
  type ProductId,
} from "@cubby/schemas/identifiers";
import {
  importWriterInput,
  importWriterOutput,
  type ExtractedPurchaseLine,
  type ImportWriterInput,
  type ImportWriterOutput,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { expenseCostDollarsSql } from "~/server/db/computed/expense-aggregate-sql";
import {
  getDb,
  notDeleted,
} from "~/server/db/helpers";
import {
  columnArrayParam,
  textArrayParam,
  uuidArrayParam,
} from "~/server/db/helpers/query";
import {
  entityExternalId,
  expense,
  ledgerParty,
  ledgerSourceClaim,
  product,
  run as runTable,
  vendorAccount,
} from "~/server/db/schema";
import {
  externalIdKey,
  findProductsByExternalIds,
  type ExternalIdPair,
  type ProductHit,
} from "~/server/domains/product/repo/find-by-external-ids";
import { upsertAgentProductMatch } from "~/server/domains/product/repo/match/product-match-candidate";
import {
  lookupProductIdentifierSources,
  resolveProductIdentifierSource,
} from "~/server/domains/product/repo/product-identifier-source";
import {
  findExactProductNameMatchesByName,
  findProductIdentityReviewCandidatesByName,
  type findExactProductNameMatches,
  type findProductIdentityReviewCandidates,
} from "~/server/domains/product/repo/resolve-names";
import { type ExistingExpenseSnapshot } from "~/server/domains/purchase-import/policy/import-lines";
import { sourceOrderKey } from "~/server/domains/purchase-import/repo/source-order-key";
import {
  lineIdentifiers,
  lineIdentifierRequests,
  lineExternalIdentity,
  type ExplicitDistinctFrom,
  type LineIdentityDecision,
} from "~/server/domains/purchase-import/repo/writer-decisions";
import { createAppError } from "~/server/errors/app-error";
import {
  ensureExternalSources,
  lockExternalIdentifierParents,
} from "~/server/generic/entity-links/repo/entity-external-ids";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  learnPurchaseProductExternalId,
  PurchaseProductExternalIdCollisionError,
} from "./external-id-learning";


async function assertImportOwnership(
  db: Database,
  input: ImportWriterInput,
  actorUserId: string,
) {
  const database = getDb(db);
  const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  const [owned] = await database
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .innerJoin(
      runTable,
      and(
        eq(runTable.id, runEntityId.parse(input.runId)),
        eq(runTable.ledgerPartyId, ledgerParty.id),
        eq(runTable.actorUserId, userIdSchema.parse(actorUserId)),
      ),
    )
    .leftJoin(
      vendorAccount,
      input.vendorAccountId
        ? and(
            eq(
              vendorAccount.id,
              parseEntityId("vendorAccount", input.vendorAccountId),
            ),
            eq(vendorAccount.ledgerPartyId, ledgerParty.id),
            eq(vendorAccount.vendorId, parseEntityId("vendor", input.vendorId)),
            notDeleted(vendorAccount),
          )
        : sql`false`,
    )
    .where(
      and(
        eq(ledgerParty.id, partyId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
        input.vendorAccountId ? isNotNull(vendorAccount.id) : undefined,
      ),
    )
    .limit(1);
  if (!owned)
    throw new Error("Import source is not owned by the authenticated member");
}

export async function existingExpenses(
  tx: DrizzleTransaction,
  purchaseId: ReturnType<typeof parseEntityId<"purchase">>,
): Promise<ExistingExpenseSnapshot[]> {
  const rows = await tx
    .select({
      id: expense.id,
      title: expense.name,
      amount: expenseCostDollarsSql(),
      lineKind: expense.lineKind,
      lineBasis: expense.lineBasis,
      productQuantity: expense.productQuantity,
      productId: expense.productId,
      tradeId: expense.trade,
      projectId: expense.projectId,
      costType: expense.costType,
      sourceClaimId: ledgerSourceClaim.id,
    })
    .from(expense)
    .leftJoin(
      ledgerSourceClaim,
      and(
        eq(ledgerSourceClaim.expenseId, expense.id),
        notDeleted(ledgerSourceClaim),
      ),
    )
    .where(
      and(
        eq(expense.purchaseId, purchaseId),
        eq(expense.economicRole, "vendor"),
        notDeleted(expense),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    amount: row.amount,
    lineKind: row.lineKind,
    lineBasis: row.lineBasis,
    productQuantity: row.productQuantity,
    productId: row.productId,
    tradeId: row.tradeId,
    projectId: row.projectId,
    costType: row.costType,
    sourceClaimed: row.sourceClaimId !== null,
  }));
}

type ProductMatchProposal = Parameters<typeof upsertAgentProductMatch>[1];
type IdentityGuardFacts = {
  owners: Map<string, ProductHit[]>;
  exact: Awaited<ReturnType<typeof findExactProductNameMatches>>;
  review: Awaited<ReturnType<typeof findProductIdentityReviewCandidates>>;
};
type PendingOwner = { request: ExternalIdPair; shortcode: string };

/** Guard reads for several created lines: one statement per read kind. */
async function loadIdentityGuardFacts(
  tx: DrizzleTransaction,
  entries: readonly { line: ExtractedPurchaseLine; source: string }[],
): Promise<Map<ExtractedPurchaseLine, IdentityGuardFacts>> {
  if (!entries.length) return new Map();
  const owners = await findProductsByExternalIds(
    tx,
    entries.flatMap(({ line, source }) => lineIdentifierRequests(source, line)),
  );
  const titles = entries.map(({ line }) => line.title);
  const exact = await findExactProductNameMatchesByName(tx, titles);
  const review = await findProductIdentityReviewCandidatesByName(tx, titles);
  return new Map(
    entries.map(({ line }) => [
      line,
      {
        owners,
        exact: exact.get(line.title) ?? [],
        review: review.get(line.title) ?? [],
      },
    ]),
  );
}

/**
 * A created Product must not fork an Exact identity match (terminology). An
 * identifier another Product owns always refuses; exact names and strong live
 * brand/item candidates require a sourced Distinct-from decision. A distinct Product still
 * cannot take the identical name, which the (name, brandName) index holds.
 * `pending` holds identifiers this commit learned but has not written yet.
 */
function assertNoUnreviewedIdentity(
  line: ExtractedPurchaseLine,
  source: string,
  facts: IdentityGuardFacts,
  distinctFrom: readonly ExplicitDistinctFrom[],
  pending: readonly PendingOwner[] = [],
) {
  for (const request of lineIdentifierRequests(source, line)) {
    const owner =
      facts.owners.get(externalIdKey(request))?.[0] ??
      pending.find(
        (held) =>
          held.request.source === request.source &&
          held.request.externalId === request.externalId &&
          (request.kind === undefined || request.kind === held.request.kind),
      );
    if (owner)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Line "${line.title}" carries ${request.kind} ${request.externalId}, which ${owner.shortcode} already owns; resolve the line to ${owner.shortcode} or merge instead of creating another Product.`,
      );
  }
  const cleared = new Set(distinctFrom.map(({ productId }) => productId));
  for (const match of new Map(
    [...facts.exact, ...facts.review].map((row) => [row.id, row]),
  ).values()) {
    if (!cleared.has(match.id))
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Line "${line.title}" matches or resembles ${match.shortcode} ("${match.name}"); resolve the line to ${match.shortcode}, or mark it distinctFrom ${match.shortcode} with a Source showing the difference.`,
      );
    if (match.name === line.title && match.brandName === null)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `A distinct Product cannot take the identical name of ${match.shortcode} ("${match.name}"); give ${match.shortcode} its brandName or a distinguishing name first.`,
      );
  }
}

const lineIdentifierSource = (
  tx: DrizzleTransaction,
  line: ExtractedPurchaseLine,
  vendorId: string,
) =>
  resolveProductIdentifierSource(tx, {
    url: line.productUrl,
    vendorId: parseEntityId("vendor", vendorId),
  });

/** Preview the same creation guard commit enforces against current identities. */
export async function assertNewLineProductIdentity(
  tx: DrizzleTransaction,
  line: ExtractedPurchaseLine,
  vendorId: string,
  distinctFrom: readonly ExplicitDistinctFrom[],
) {
  const source = lineIdentifiers(line).length
    ? await lineIdentifierSource(tx, line, vendorId)
    : "";
  const facts = await loadIdentityGuardFacts(tx, [{ line, source }]);
  assertNoUnreviewedIdentity(line, source, facts.get(line)!, distinctFrom);
}

type LearnedIdentifier = {
  source: string;
  kind: ReturnType<typeof lineIdentifiers>[number]["kind"];
  externalId: string;
};
type IdentifierSlot = Pick<LearnedIdentifier, "source" | "externalId"> & {
  kind: string;
};
const learnedKey = ({ source, kind, externalId }: IdentifierSlot) =>
  `${source}\0${kind}\0${externalId}`;
const primarySlotKey = (productId: string, identifier: IdentifierSlot) =>
  `${productId}\0${identifier.source}\0${identifier.kind}`;

/**
 * Live owners of `identifiers`, of any entity kind, and the primary slots
 * `primaryOf` holds for their (source, kind), in one statement.
 */
async function readLearnedIdentifiers(
  tx: DrizzleTransaction,
  identifiers: readonly LearnedIdentifier[],
  primaryOf?: ProductId,
) {
  const owners = new Map<string, string>();
  const primaries = new Set<string>();
  if (!identifiers.length) return { owners, primaries };
  const rows = await tx
    .select({
      entityId: entityExternalId.entityId,
      source: entityExternalId.source,
      kind: entityExternalId.kind,
      externalId: entityExternalId.externalId,
      isPrimary: entityExternalId.isPrimary,
    })
    .from(entityExternalId)
    .where(
      and(
        notDeleted(entityExternalId),
        sql`${entityExternalId.source} = ANY(${textArrayParam(identifiers.map(({ source }) => source))})`,
        sql`${entityExternalId.kind} = ANY(${columnArrayParam(identifiers.map(({ kind }) => kind))})`,
        or(
          sql`${entityExternalId.externalId} = ANY(${textArrayParam(identifiers.map(({ externalId }) => externalId))})`,
          primaryOf
            ? and(
                eq(entityExternalId.entityId, primaryOf),
                eq(entityExternalId.isPrimary, true),
              )
            : undefined,
        ),
      ),
    );
  const wanted = new Set(identifiers.map(learnedKey));
  for (const row of rows) {
    const key = learnedKey(row);
    if (wanted.has(key) && !owners.has(key)) owners.set(key, row.entityId);
    if (primaryOf && row.entityId === primaryOf && row.isPrimary)
      primaries.add(primarySlotKey(primaryOf, row));
  }
  return { owners, primaries };
}

const collisionProposal = (
  line: ExtractedPurchaseLine,
  productId: ProductId,
  identifier: LearnedIdentifier,
  ownerProductId: ProductId,
): ProductMatchProposal => ({
  productIds: [productId, ownerProductId],
  evidence: `Order line "${line.title}" carries ${identifier.source}/${identifier.kind} ${identifier.externalId}, which already identifies the other Product. Confirm whether both are the same exact variant before merging.`,
  sourceUrls: line.productUrl ? [line.productUrl] : [],
});

export type LineProducts = ReturnType<typeof lineProductResolver>;

/**
 * Resolves each line's Product in line order, as a per-line resolve would,
 * from reads batched across the lines in `requests`. A line whose SKU an
 * earlier line resolved reuses that Product; a second `new` line with the same
 * title reuses the Product this commit just created. An identifier another
 * Product already owns is never reassigned and never aborts the order: the
 * line keeps its Product, and the pair is proposed for human identity review
 * at that line. Learned identifiers are written by `flush`, which the caller
 * runs after its last `resolve`.
 *
 * Lock order matches a per-line resolve: the issuer registers at the first
 * line that needs it, and a reviewed Product is locked at its first line that
 * learns an identifier. Products this commit creates take no lock.
 */
export function lineProductResolver(
  tx: DrizzleTransaction,
  vendorId: string,
  requests: readonly {
    line: ExtractedPurchaseLine;
    decision: LineIdentityDecision;
  }[],
  options: { onIdentifierCollision?: (proposal: ProductMatchProposal) => void },
) {
  const resolving = requests.filter(
    ({ decision }) =>
      decision.productId || decision.promote || decision.unresolvedReason,
  );
  const creating = resolving.flatMap(({ line, decision }) =>
    !decision.productId && decision.lineKind === "principal" && decision.promote
      ? [line]
      : [],
  );
  const sources = new Map<ExtractedPurchaseLine, string>();
  const guards = new Map<ExtractedPurchaseLine, IdentityGuardFacts>();
  const storedOwners = new Map<string, string>();
  const ownersRead = new Set<string>();
  let liveReviewed = new Map<string, string>();
  let started = false;
  let registered = false;
  const byIdentity = new Map<string, string>();
  const shortcodes = new Map<string, string>();
  const locked = new Set<string>();
  const pendingOwners = new Map<string, ProductId>();
  const pendingPrimaries = new Set<string>();
  const pending: (LearnedIdentifier & {
    productId: ProductId;
    line: ExtractedPurchaseLine;
    isPrimary: boolean;
  })[] = [];

  const emit = async (proposals: readonly ProductMatchProposal[]) => {
    for (const proposal of proposals) {
      if (options.onIdentifierCollision)
        options.onIdentifierCollision(proposal);
      else await upsertAgentProductMatch(tx, proposal);
    }
  };
  const learnedIdentifiers = (line: ExtractedPurchaseLine, source: string) => {
    const normalized = source.trim().toLowerCase();
    return lineIdentifiers(line).map(({ kind, externalId }) => ({
      source: normalized,
      kind,
      externalId,
    }));
  };
  const readStoredOwners = async (identifiers: LearnedIdentifier[]) => {
    const unread = identifiers.filter((id) => !ownersRead.has(learnedKey(id)));
    if (!unread.length) return;
    const { owners } = await readLearnedIdentifiers(tx, unread);
    for (const identifier of unread) ownersRead.add(learnedKey(identifier));
    for (const [key, owner] of owners) storedOwners.set(key, owner);
  };

  // Reads that need no issuer, after the caller's locks.
  const start = async () => {
    started = true;
    // A malformed id fails at its own line, as a per-line resolve would.
    const reviewed = [
      ...new Set(resolving.flatMap(({ decision }) => decision.productId ?? [])),
    ].flatMap((id) => {
      try {
        return [parseEntityId("product", id)];
      } catch {
        return [];
      }
    });
    if (reviewed.length)
      liveReviewed = new Map(
        (
          await tx
            .select({ id: product.id, shortcode: product.shortcode })
            .from(product)
            .where(
              and(
                notDeleted(product),
                sql`${product.id} = ANY(${uuidArrayParam(reviewed)})`,
              ),
            )
        ).map((row) => [row.id, row.shortcode]),
      );
    const plain = creating.filter((line) => !lineIdentifiers(line).length);
    for (const [line, facts] of await loadIdentityGuardFacts(
      tx,
      plain.map((line) => ({ line, source: "" })),
    ))
      guards.set(line, facts);
  };

  // The issuer registers at the first line that needs it; the rest read the
  // registry it leaves. A line that registry cannot answer registers itself
  // and fails there with its own error.
  const sourceFor = async (line: ExtractedPurchaseLine) => {
    if (!lineIdentifiers(line).length) return "";
    const known = sources.get(line);
    if (known !== undefined) return known;
    const source = await lineIdentifierSource(tx, line, vendorId);
    sources.set(line, source);
    if (registered) return source;
    registered = true;
    const rest = resolving.filter(
      (request) =>
        !sources.has(request.line) && lineIdentifiers(request.line).length,
    );
    const looked = await lookupProductIdentifierSources(
      tx,
      rest.map((request) => ({
        url: request.line.productUrl,
        vendorId: parseEntityId("vendor", vendorId),
      })),
    );
    rest.forEach((request, index) => {
      const lookup = looked[index];
      if (lookup?.source) sources.set(request.line, lookup.source);
    });
    const identified = creating.flatMap((created) => {
      const known = sources.get(created);
      return known === undefined || guards.has(created)
        ? []
        : [{ line: created, source: known }];
    });
    for (const [created, facts] of await loadIdentityGuardFacts(tx, identified))
      guards.set(created, facts);
    await readStoredOwners(
      identified.flatMap(({ line: created, source: known }) =>
        learnedIdentifiers(created, known),
      ),
    );
    return source;
  };

  const learn = async (
    productId: ProductId,
    line: ExtractedPurchaseLine,
    source: string,
    reviewed: boolean,
  ) => {
    const identifiers = learnedIdentifiers(line, source);
    if (!identifiers.length) return;
    let owners: ReadonlyMap<string, string> = storedOwners;
    let primaries: ReadonlySet<string> = new Set();
    if (reviewed) {
      if (!locked.has(productId)) {
        await lockExternalIdentifierParents(tx, [
          { entityId: productId, entityKind: "product" },
        ]);
        locked.add(productId);
      }
      ({ owners, primaries } = await readLearnedIdentifiers(
        tx,
        identifiers,
        productId,
      ));
    } else await readStoredOwners(identifiers);
    const proposals: ProductMatchProposal[] = [];
    for (const identifier of identifiers) {
      const key = learnedKey(identifier);
      const owner = pendingOwners.get(key) ?? owners.get(key);
      if (owner) {
        if (owner !== productId)
          proposals.push(
            collisionProposal(
              line,
              productId,
              identifier,
              parseEntityId("product", owner),
            ),
          );
        continue;
      }
      const slot = primarySlotKey(productId, identifier);
      const isPrimary = !primaries.has(slot) && !pendingPrimaries.has(slot);
      pendingOwners.set(key, productId);
      if (isPrimary) pendingPrimaries.add(slot);
      pending.push({ ...identifier, productId, line, isPrimary });
    }
    await emit(proposals);
  };

  const pendingGuardOwners = (): PendingOwner[] =>
    pending.map(({ source, kind, externalId, productId }) => ({
      request: { source, kind, externalId },
      shortcode: shortcodes.get(productId) ?? productId,
    }));

  return {
    async resolve(
      line: ExtractedPurchaseLine,
      decision: LineIdentityDecision,
      onCreated?: (productId: ProductId) => void,
    ): Promise<ProductId | null> {
      // A line decided to carry no Product (expense-only, or coarse-only)
      // keeps none, even when an earlier line with the same SKU resolved one.
      if (
        !decision.productId &&
        !decision.promote &&
        !decision.unresolvedReason
      )
        return null;
      if (!started) await start();
      const source = await sourceFor(line);
      const externalIdentity = lineExternalIdentity(line, source);
      const resolvedEarlier = externalIdentity
        ? byIdentity.get(externalIdentity)
        : null;
      if (resolvedEarlier) return parseEntityId("product", resolvedEarlier);
      if (decision.productId) {
        const reviewedId = parseEntityId("product", decision.productId);
        const shortcode =
          liveReviewed.get(reviewedId) ??
          (
            await tx
              .select({ shortcode: product.shortcode })
              .from(product)
              .where(and(eq(product.id, reviewedId), notDeleted(product)))
          )[0]?.shortcode;
        if (!shortcode)
          throw new Error("The reviewed Product no longer exists.");
        shortcodes.set(reviewedId, shortcode);
        await learn(reviewedId, line, source, true);
        if (externalIdentity) byIdentity.set(externalIdentity, reviewedId);
        return reviewedId;
      }
      if (decision.lineKind !== "principal" || !decision.promote) return null;
      const titleKey = `title:${line.title.trim().toLowerCase()}`;
      const createdEarlier = byIdentity.get(titleKey);
      if (createdEarlier) return parseEntityId("product", createdEarlier);
      let facts = guards.get(line);
      if (!facts) {
        facts = (await loadIdentityGuardFacts(tx, [{ line, source }])).get(
          line,
        )!;
        guards.set(line, facts);
      }
      assertNoUnreviewedIdentity(
        line,
        source,
        facts,
        decision.distinctFrom ?? [],
        pendingGuardOwners(),
      );
      const created = await insertWithShortcode(tx, "product", {
        name: line.title,
        brandId: null,
        notes:
          decision.distinctFrom
            ?.map(({ url, quote }) => [quote, url].filter(Boolean).join("\n"))
            .join("\n\n") || null,
      });
      onCreated?.(created.id);
      shortcodes.set(created.id, created.shortcode);
      await learn(created.id, line, source, false);
      if (externalIdentity) byIdentity.set(externalIdentity, created.id);
      byIdentity.set(titleKey, created.id);
      return created.id;
    },

    /** Writes the identifiers `resolve` learned. A write another transaction
     * raced takes the single-identifier path, which settles it. */
    async flush() {
      const rows = pending.splice(0);
      if (!rows.length) return;
      await ensureExternalSources(
        tx,
        rows.map(({ source }) => source),
      );
      const inserted = await tx
        .insert(entityExternalId)
        .values(
          rows.map((row) => ({
            entityId: row.productId,
            entityKind: "product" as const,
            source: row.source,
            kind: row.kind,
            externalId: row.externalId,
            url: row.line.productUrl ?? null,
            isPrimary: row.isPrimary,
          })),
        )
        .onConflictDoNothing()
        .returning({
          source: entityExternalId.source,
          kind: entityExternalId.kind,
          externalId: entityExternalId.externalId,
        });
      const written = new Set(inserted.map(learnedKey));
      const proposals: ProductMatchProposal[] = [];
      for (const row of rows) {
        if (written.has(learnedKey(row))) continue;
        try {
          await learnPurchaseProductExternalId(tx, {
            productId: row.productId,
            source: row.source,
            kind: row.kind,
            externalId: row.externalId,
            url: row.line.productUrl,
          });
        } catch (error) {
          if (!(error instanceof PurchaseProductExternalIdCollisionError))
            throw error;
          proposals.push(
            collisionProposal(
              row.line,
              row.productId,
              row,
              error.ownerProductId,
            ),
          );
        }
      }
      await emit(proposals);
    },
  };
}


/** Accepted source facts dirty one economic event; only the kernel writes its ledger. */
export async function importVendorOrder(
  db: Database,
  rawInput: ImportWriterInput,
  actorUserId: string,
): Promise<ImportWriterOutput> {
  const input = importWriterInput.parse(rawInput);
  await assertImportOwnership(db, input, actorUserId);
  const orderKey = sourceOrderKey({vendorId: input.vendorId,
    orderId: input.extraction.candidate?.orderId ?? null,
    orderLocator: input.orderLocator ?? input.source.externalKey});
  const {appendOrderEvidence, orderEventKey} = await import("./order-evidence");
  const observations = await appendOrderEvidence(db, [{input, orderKey}]);
  const current = observations.at(-1);
  if (!current) throw new Error("Accepted order evidence is missing");
  const {settleOrderEvidence} = await import("./settle-order-evidence");
  const outcomes = await settleOrderEvidence(db, [current]);
  const {repositoryQueries} = await import("~/server/db/repository-access.boundary");
  const {recordKey, evidenceBinding} = await import("~/server/db/kernel-schema");
  const q = repositoryQueries(db);
  const bindings = await q.select().from(evidenceBinding).where(eq(evidenceBinding.factId, current.id));
  const scope = bindings.find(row => row.factKind === "orderObservation")?.eventKey ?? orderEventKey(current);
  const records = await q.select().from(recordKey).where(and(eq(recordKey.scopeKind,"purchaseEvent"),eq(recordKey.scopeKey,scope),eq(recordKey.entity,"purchase")));
  const purchaseId = records[0]?.entityId ?? null;
  return importWriterOutput.parse({outcome: purchaseId ? "created" : "conflict", purchaseId,
    findingIds: [], outputFingerprint: await sha256Hex(JSON.stringify(outcomes))});
}
