import type { EntityRef } from "@cubby/schemas/entity";
import type { ConnectionCandidate } from "@cubby/schemas/entity-connections";
import { basisValueOf } from "@cubby/schemas/field-suggestion";
import type { RunId } from "@cubby/schemas/identifiers";
import type { SearchableEntity } from "@cubby/schemas/search";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  acquisitionBrandKey,
  acquisitionBrandText,
  acquisitionBrandTexts,
  acquisitionPairKey,
  eligibleAcquisitionPairs,
  eligibleConnectionExpenses,
  expenseConnectionEligible,
  knownBrandSlugs,
  otherBrandNamed,
  retrieveAcquisitionNotes,
} from "~/server/domains/connection/repo/connection-candidates";
import { connectionRecord } from "~/server/domains/connection/repo/connection-evidence";
import { semanticEntityCandidateScan } from "~/server/generic/embedding/service/semantic-search.service";
import { SEMANTIC_MATCH_MIN_SIMILARITY } from "~/server/generic/embedding/service/semantic/constants";
import { findLexicalSearchCandidates } from "~/server/generic/search/service/search.service";

/** Bounded indexed retrieval, including unitemized orders with evidence in notes. */
export async function discoverAcquisitionCandidateScan(
  db: Database,
  source: EntityRef,
  options: { runId?: RunId } = {},
): Promise<{
  candidates: ConnectionCandidate[];
  complete: boolean;
  coverageErrors: string[];
}> {
  if (!["product", "purchase", "expense"].includes(source.entityKind))
    return { candidates: [], complete: true, coverageErrors: [] };
  if (
    source.entityKind === "expense" &&
    !(await expenseConnectionEligible(db, source.entityId))
  )
    return { candidates: [], complete: true, coverageErrors: [] };
  const record = z
    .record(z.string(), z.json())
    .parse((await connectionRecord(db, source)).row);
  const productBrandName =
    source.entityKind === "product"
      ? await acquisitionBrandText(db, source)
      : null;
  const identity = [
    record.name,
    productBrandName,
    record.model,
    record.displayLabel,
  ]
    .map(basisValueOf)
    .filter((value) => value !== null)
    .join(" ")
    .trim();
  const description = [record.notes, record.description]
    .map(basisValueOf)
    .filter((value) => value !== null)
    .join(" ")
    .trim()
    .slice(0, 500);
  const queries = [
    ...new Set(
      [basisValueOf(record.name) ?? identity, description || identity].filter(
        (q) => q.length >= 3,
      ),
    ),
  ].slice(0, 2);
  const kinds: SearchableEntity[] =
    source.entityKind === "product" ? ["purchase", "expense"] : ["product"];
  const candidates = new Map<string, ConnectionCandidate>();
  const coverageErrors: string[] = [];
  const notes = await retrieveAcquisitionNotes(db, source, {
    name: basisValueOf(record.name) ?? identity,
    notes: description,
  });
  // The source's own brand text: Product brandName or the Expense line.
  const sourceBrandText =
    source.entityKind === "product"
      ? productBrandName
      : basisValueOf(record.name);
  // The searches are independent; run them together, then filter every hit
  // in the original kind/query/list order with batched eligibility.
  // Lexical search takes only the identity query. A description-length query
  // ANDs dozens of prefix terms and trigram-compares the whole string, which
  // took 150-400 ms per search on production data and matched only records
  // its semantic search already finds.
  const lexicalQuery = queries[0];
  const searches = await Promise.all(
    kinds.flatMap((kind) =>
      queries.map(async (query) => {
        const [lexical, semantic] = await Promise.all([
          query === lexicalQuery
            ? findLexicalSearchCandidates(
                db,
                { query, entityKinds: [kind], limit: 10 },
                10,
              )
            : [],
          semanticEntityCandidateScan(db, query, 10, kind, options.runId),
        ]);
        return { kind, lexical, semantic };
      }),
    ),
  );
  const pairs: { from: EntityRef; to: EntityRef }[] = [];
  for (const { kind, lexical, semantic } of searches) {
    if (!semantic.complete)
      coverageErrors.push(
        semantic.error ?? `Semantic coverage is unconfirmed for ${kind}`,
      );
    const otherRefs: EntityRef[] = [
      ...lexical.map((hit) => ({ entityKind: kind, entityId: hit.id })),
      // Meaning alone must clear the floor; a record also hit lexically or
      // by notes still enters through those lists.
      ...semantic.candidates
        .filter(({ similarity }) => similarity >= SEMANTIC_MATCH_MIN_SIMILARITY)
        .map(({ item }) => ({ entityKind: kind, entityId: item.id })),
      ...notes.filter((ref) => ref.entityKind === kind),
    ];
    for (const other of otherRefs)
      pairs.push(
        source.entityKind === "product"
          ? { from: source, to: other }
          : { from: other, to: source },
      );
  }
  const expenseCodes = pairs.flatMap(({ to }) =>
    to.entityKind === "expense" ? [to.entityId] : [],
  );
  const purchasePairs = pairs.flatMap(({ from, to }) =>
    to.entityKind === "purchase"
      ? [{ productCode: from.entityId, purchaseCode: to.entityId }]
      : [],
  );
  const [eligibleExpenses, eligiblePairs] = await Promise.all([
    eligibleConnectionExpenses(db, expenseCodes),
    eligibleAcquisitionPairs(db, purchasePairs),
  ]);
  const branded = pairs.filter(
    ({ to }) =>
      to.entityKind === "expense" && eligibleExpenses.has(to.entityId),
  );
  const [brands, brandTexts] = branded.length
    ? await Promise.all([
        knownBrandSlugs(db),
        acquisitionBrandTexts(
          db,
          branded.map(({ from, to }) =>
            source.entityKind === "product" ? to : from,
          ),
        ),
      ])
    : [new Set<string>(), new Map<string, string | null>()];
  for (const { from, to } of pairs) {
    if (to.entityKind === "expense") {
      if (!eligibleExpenses.has(to.entityId)) continue;
      const brandName =
        source.entityKind === "product"
          ? sourceBrandText
          : (brandTexts.get(acquisitionBrandKey(from)) ?? null);
      const line =
        source.entityKind === "expense"
          ? sourceBrandText
          : (brandTexts.get(acquisitionBrandKey(to)) ?? null);
      if (line && otherBrandNamed(line, brandName, brands)) continue;
    }
    if (
      to.entityKind === "purchase" &&
      !eligiblePairs.has(acquisitionPairKey(from.entityId, to.entityId))
    )
      continue;
    const relation =
      to.entityKind === "purchase" ? "product-purchase" : "product-expense";
    const key = `${relation}:${from.entityId}:${to.entityId}`;
    if (candidates.has(key)) continue;
    candidates.set(key, {
      relation,
      source: from,
      target: to,
      label:
        relation === "product-purchase"
          ? "Review retrospective acquisition"
          : "Review acquisition expense",
      evidence: {
        reasons: [
          "Retrieved from saved name, description or notes using indexed lexical/semantic search",
        ],
        contradictions: [],
        unknowns: [
          "Retrieval similarity is not proof of identity or acquisition",
          "Confirm the source document; no amount, quantity, delivery or inventory is inferred",
        ],
      },
    });
  }
  return {
    candidates: [...candidates.values()].slice(0, 30),
    complete: coverageErrors.length === 0,
    coverageErrors: [...new Set(coverageErrors)],
  };
}

/** Advisory callers can use positives without claiming complete discovery. */
export async function discoverAcquisitionCandidates(
  db: Database,
  source: EntityRef,
): Promise<ConnectionCandidate[]> {
  return (await discoverAcquisitionCandidateScan(db, source)).candidates;
}
