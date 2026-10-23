import type { EntityRef } from "@cubby/schemas/entity";
import type { ConnectionCandidate } from "@cubby/schemas/entity-connections";
import { basisValueOf } from "@cubby/schemas/field-suggestion";
import type { SearchableEntity } from "@cubby/schemas/search";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  acquisitionBrandText,
  expenseConnectionEligible,
  knownBrandSlugs,
  otherBrandNamed,
  retrieveAcquisitionNotes,
  acquisitionPairEligible,
} from "~/server/domains/connection/repo/connection-candidates";
import { connectionRecord } from "~/server/domains/connection/repo/connection-evidence";
import { semanticEntityCandidateScan } from "~/server/generic/embedding/service/semantic-search.service";
import { SEMANTIC_MATCH_MIN_SIMILARITY } from "~/server/generic/embedding/service/semantic/constants";
import { findLexicalSearchCandidates } from "~/server/generic/search/service/search.service";

/** Bounded indexed retrieval, including unitemized orders with evidence in notes. */
export async function discoverAcquisitionCandidateScan(
  db: Database,
  source: EntityRef,
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
  const identity = [
    record.name,
    record.brandName,
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
  // Resolved once per call: the source's own brand text (Product brandName
  // or Expense line) and, on first Expense pairing, the known-brand slugs.
  const sourceBrandText =
    source.entityKind === "product"
      ? basisValueOf(record.brandName)
      : basisValueOf(record.name);
  let brands: Set<string> | undefined;
  for (const kind of kinds)
    for (const query of queries) {
      const [lexical, semantic] = await Promise.all([
        findLexicalSearchCandidates(
          db,
          { query, entityKinds: [kind], limit: 10 },
          10,
        ),
        semanticEntityCandidateScan(db, query, 10, kind),
      ]);
      if (!semantic.complete)
        coverageErrors.push(
          semantic.error ?? `Semantic coverage is unconfirmed for ${kind}`,
        );
      const otherRefs: EntityRef[] = [
        ...lexical.map((hit) => ({ entityKind: kind, entityId: hit.id })),
        // Meaning alone must clear the floor; a record also hit lexically or
        // by notes still enters through those lists.
        ...semantic.candidates
          .filter(
            ({ similarity }) => similarity >= SEMANTIC_MATCH_MIN_SIMILARITY,
          )
          .map(({ item }) => ({ entityKind: kind, entityId: item.id })),
        ...notes.filter((ref) => ref.entityKind === kind),
      ];
      for (const other of otherRefs) {
        const from = source.entityKind === "product" ? source : other;
        const to = source.entityKind === "product" ? other : source;
        if (to.entityKind === "expense") {
          if (!(await expenseConnectionEligible(db, to.entityId))) continue;
          brands ??= await knownBrandSlugs(db);
          const brandName =
            source.entityKind === "product"
              ? sourceBrandText
              : await acquisitionBrandText(db, from);
          const line =
            source.entityKind === "expense"
              ? sourceBrandText
              : await acquisitionBrandText(db, to);
          if (line && otherBrandNamed(line, brandName, brands)) continue;
        }
        if (
          to.entityKind === "purchase" &&
          !(await acquisitionPairEligible(db, from.entityId, to.entityId))
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
