import type { ProblemKey } from "@cubby/schemas/problems";
import { problemDetectors } from "@cubby/schemas/problems-raw-read";
import type { ParsedShortcode } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";

import { problemQueryDeclarations } from "~/entity/problems/problem-registry";
import type { ProjectWorkContext } from "~/server/domains/project/repo/work-context";
import { diagnosticWorkCandidates } from "~/server/domains/work/repo/work-diagnostics";
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

export const diagnosticWorkSources = (
  context: ProjectWorkContext,
): WorkSource[] =>
  problemQueryDeclarations().flatMap((definition) => {
    const declaration = definition.source;
    if (
      declaration.kind !== "derived" ||
      excludedDiagnostics.has(declaration.diagnostic)
    )
      return [];
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
        if (privateDiagnosticKeys.has(definition.key)) {
          const result = await runDiagnostic(
            db,
            declaration.diagnostic,
            {},
            { kind: "sample", limit: Number.POSITIVE_INFINITY },
          );
          return diagnosticWorkCandidates(
            db,
            source,
            await Promise.all(
              result.items.map(async (item) => {
                const entry = privateProblemEntry(definition.key, item);
                return {
                  key: `problem:${definition.key}:${await sha256Hex(entry.fingerprintPayload)}`,
                  name: `${definition.title} · ${entry.refs.map((ref) => ref.shortcode).join(", ")}`,
                  reason: entry.reason,
                  refs: entry.refs,
                };
              }),
            ),
          );
        }
        const result = await runDiagnostic(
          db,
          declaration.diagnostic,
          declaration.diagnostic === "project-date-window-drift"
            ? { attentionItems: await context.attentionItems(db, scope) }
            : declaration.diagnostic === "tools-used-outside-ownership"
              ? {
                  projectDateWindows: context.load(db).then((loaded) => ({
                    tree: loaded,
                    dateWindows: loaded.dateWindows,
                  })),
                }
              : {},
          { kind: "count" },
        );
        return result.count
          ? diagnosticWorkCandidates(db, source, [
              {
                key: `problem:${definition.key}`,
                name: definition.title,
                reason: `${result.count} work items. ${definition.description}`,
                refs: [],
              },
            ])
          : null;
      },
    };
    return [source];
  });
