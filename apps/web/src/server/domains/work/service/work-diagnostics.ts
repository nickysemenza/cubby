import type { ProblemKey } from "@cubby/schemas/problems";
import { problemDetectors } from "@cubby/schemas/problems-raw-read";
import type {
  IncompleteWorkDiagnosticSource,
  WorkDiagnosticFacts,
} from "@cubby/schemas/work-diagnostic-facts";
import type { ParsedShortcode } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";

import { problemQueryDeclarations } from "~/entity/problems/problem-registry";
import {
  loadWorkDiagnosticFacts,
  loadWorkDiagnosticComputeTargets,
} from "~/server/domains/work/repo/work-diagnostic-facts";
import {
  diagnosticWorkCandidates,
  storedPrivateDiagnosticCandidates,
} from "~/server/domains/work/repo/work-diagnostics";
import type {
  DerivedCompute,
  DerivedComputed,
} from "~/server/generic/derived/repo/compute";
import { runDiagnostic } from "~/server/generic/problems/service/problem-diagnostics.service";
import { workProblemActions } from "~/server/generic/work-queue/repo/work-declarations";
import type { WorkSource } from "~/server/generic/work-queue/repo/work-source";
const excludedDiagnostics = new Set([
  "import-findings",
  "products-with-better-upc-data",
  "image-metadata-outcomes",
  "referential-liveness-violations",
  "incomplete-transaction-imports",
]);
const privateDiagnosticKeys = new Set([
  "duplicateFinancialTransactionSourceRefs",
  "duplicateFinancialAccountSourceAliases",
  "invalidFinancialJson",
  "duplicateSpendCandidates",
]);
const privateProblemEntry = (
  key: ProblemKey,
  item: unknown,
): { reason: string } & {
  refs: ParsedShortcode[];
  fingerprintPayload: string;
} => {
  switch (key) {
    case "duplicateFinancialTransactionSourceRefs": {
      const parsed =
        problemDetectors.duplicateFinancialTransactionSourceRefs.item.parse(
          item,
        );
      return {
        refs: parsed.transactionIds.map((shortcode) => ({
          type: "financialTransaction",
          shortcode,
        })),
        fingerprintPayload: JSON.stringify({
          ...parsed,
          transactionIds: [...parsed.transactionIds].sort(),
        }),
        reason: `Repeated settlement reference from ${parsed.source}: ${parsed.externalId}.`,
      };
    }
    case "duplicateFinancialAccountSourceAliases": {
      const parsed =
        problemDetectors.duplicateFinancialAccountSourceAliases.item.parse(
          item,
        );
      return {
        refs: parsed.accountIds.map((shortcode) => ({
          type: "financialAccount",
          shortcode,
        })),
        fingerprintPayload: JSON.stringify({
          ...parsed,
          accountIds: [...parsed.accountIds].sort(),
        }),
        reason: `Repeated account identity from ${parsed.source}: ${parsed.externalAccountId}.`,
      };
    }
    case "invalidFinancialJson": {
      const parsed = problemDetectors.invalidFinancialJson.item.parse(item);
      return {
        refs:
          parsed.entity === "financialAccount"
            ? [{ type: parsed.entity, shortcode: parsed.id }]
            : [{ type: parsed.entity, shortcode: parsed.id }],
        fingerprintPayload: JSON.stringify(parsed),
        reason: `${parsed.field}: ${parsed.message}`,
      };
    }
    case "duplicateSpendCandidates": {
      const parsed = problemDetectors.duplicateSpendCandidates.item.parse(item);
      return {
        refs: [
          { type: "expense", shortcode: parsed.id },
          { type: "purchase", shortcode: parsed.purchaseId },
        ],
        fingerprintPayload: JSON.stringify(parsed),
        reason: `Possible duplicate expense ${parsed.id} and purchase ${parsed.purchaseId} (${parsed.matchedOn}).`,
      };
    }
    default:
      throw new Error(
        `Private Work diagnostic ${key} has no declared references`,
      );
  }
};

const definitions = () =>
  problemQueryDeclarations().flatMap((definition) =>
    definition.source.kind === "derived" &&
    !excludedDiagnostics.has(definition.source.diagnostic)
      ? [{ ...definition, source: definition.source }]
      : [],
  );

/** Only the existing drain runs canonical population diagnostics. Failure retains the prior publication. */
export const computeWorkDiagnosticFacts: DerivedCompute = async (
  database,
  targetIds,
) => {
  const { db, ids } = await loadWorkDiagnosticComputeTargets(
    database,
    targetIds,
  );
  const out = new Map<string, DerivedComputed>();
  if (!ids.length) return out;
  const value: WorkDiagnosticFacts = { counts: {}, privateEntries: {} };
  for (const definition of definitions()) {
    if (privateDiagnosticKeys.has(definition.key)) {
      const result = await runDiagnostic(
        db,
        definition.source.diagnostic,
        {},
        { kind: "sample", limit: Number.POSITIVE_INFINITY },
      );
      if (result.status.state !== "healthy")
        throw new Error(result.status.message);
      value.privateEntries[definition.key] = await Promise.all(
        result.items.map(async (item) => {
          const entry = privateProblemEntry(definition.key, item);
          return {
            key: `problem:${definition.key}:${await sha256Hex(entry.fingerprintPayload)}`,
            name: `${definition.title} · ${entry.refs.map((ref) => ref.shortcode).join(", ")}`,
            reason: entry.reason,
            refs: entry.refs.map((ref) => {
              switch (ref.type) {
                case "financialAccount":
                case "financialTransaction":
                case "expense":
                case "purchase":
                  return ref;
                default:
                  throw new Error(
                    `Unsupported private diagnostic reference: ${ref.type}`,
                  );
              }
            }),
          };
        }),
      );
      value.counts[definition.key] = result.count;
    } else {
      const result = await runDiagnostic(
        db,
        definition.source.diagnostic,
        {},
        { kind: "count" },
      );
      if (result.status.state !== "healthy")
        throw new Error(result.status.message);
      value.counts[definition.key] = result.count;
    }
  }
  for (const id of ids) out.set(id, { value, sort: null });
  return out;
};

export const diagnosticWorkSources = () => {
  let loaded: ReturnType<typeof loadWorkDiagnosticFacts> | undefined;
  const incomplete = new Map<string, IncompleteWorkDiagnosticSource>();
  const sources: WorkSource[] = definitions().map((definition) => {
    const source: WorkSource = {
      id: definition.key,
      family: "problem",
      executor: "human",
      entity: null,
      link: { kind: "reason" },
      reasons: [{ key: definition.key, label: definition.title }],
      actions: workProblemActions(definition.key),
      candidates: async (db, scope) => {
        if (scope.record) return null;
        const publication = await (loaded ??= loadWorkDiagnosticFacts(db));
        const count = publication?.counts?.[definition.key];
        if (count === undefined || publication?.stale || publication?.error)
          incomplete.set(definition.key, {
            key: definition.key,
            state: count === undefined ? "unavailable" : "stale",
            pending: publication?.pending ?? false,
            error: publication?.error ?? null,
            computedAt: publication?.computedAt ?? null,
          });
        if (count === undefined || !publication) return null;
        if (privateDiagnosticKeys.has(definition.key))
          return storedPrivateDiagnosticCandidates(db, source, publication);
        if (count === 0) return null;
        return diagnosticWorkCandidates(db, source, {
          key: `problem:${definition.key}`,
          name: definition.title,
          reason: `${count} work items. ${definition.description}`,
        });
      },
    };
    return source;
  });
  return {
    sources,
    incompleteDiagnosticSources: async () => [...incomplete.values()],
  };
};
