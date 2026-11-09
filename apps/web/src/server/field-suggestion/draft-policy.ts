import { resolveExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import type { FieldResolutions } from "@cubby/schemas/field-resolution";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { resolveDraftExpenseFields } from "~/server/domains/expense/repo/expense-inheritance";
import { resolveDraftTaskFields } from "~/server/domains/task/repo/task-project-inheritance";

export interface DraftSuggestionResolvers {
  resolveExpense: typeof resolveDraftExpenseFields;
  resolveTask: typeof resolveDraftTaskFields;
}

export const draftSuggestionResolvers: DraftSuggestionResolvers = {
  resolveExpense: resolveDraftExpenseFields,
  resolveTask: resolveDraftTaskFields,
};

type Draft = Record<string, z.infer<typeof z.json>>;
type DraftPolicy = {
  normalize: (draft: Draft) => Draft;
  resolve: (
    db: Database,
    draft: Draft,
    ports: DraftSuggestionResolvers,
  ) => Promise<FieldResolutions>;
  previewTarget: (field: string, draft: Draft) => boolean;
};

const policies = {
  expense: {
    normalize: (draft) => ({
      ...draft,
      // SAFETY: callers validate lineKind and productId as strings or null.
      lineKind: resolveExpenseLineKind(
        draft as Parameters<typeof resolveExpenseLineKind>[0],
      ),
    }),
    // SAFETY: callers validate draft values before entering the resolver.
    resolve: (db, draft, ports) =>
      ports.resolveExpense(
        db,
        draft as Parameters<typeof resolveDraftExpenseFields>[1],
      ),
    previewTarget: (field, draft) =>
      field !== "projectId" ||
      draft.lineKind === undefined ||
      draft.lineKind === "principal",
  },
  task: {
    normalize: (draft) => draft,
    // SAFETY: callers validate draft values before entering the resolver.
    resolve: (db, draft, ports) =>
      ports.resolveTask(
        db,
        draft as Parameters<typeof resolveDraftTaskFields>[1],
      ),
    previewTarget: () => true,
  },
} satisfies Record<string, DraftPolicy>;

function policyFor(entity: string): DraftPolicy | undefined {
  return Object.entries(policies).find(([key]) => key === entity)?.[1];
}

export function normalizeSuggestionDraft<T extends Draft>(
  entity: string,
  draft: T,
): T {
  // SAFETY: normalization preserves the draft keys and only replaces lineKind.
  return (policyFor(entity)?.normalize(draft) ?? draft) as T;
}

export function resolveSuggestionDraft(
  db: Database,
  entity: string,
  draft: Draft,
  ports: DraftSuggestionResolvers = draftSuggestionResolvers,
): Promise<FieldResolutions> | undefined {
  return policyFor(entity)?.resolve(db, draft, ports);
}

export function allowsPreviewSuggestionTarget(
  entity: string,
  field: string,
  draft: Draft,
): boolean {
  return policyFor(entity)?.previewTarget(field, draft) ?? true;
}
