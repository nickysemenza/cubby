import { resolveExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import type { FieldResolutions } from "@cubby/schemas/field-resolution";
import { z } from "zod";

import type { Database } from "~/server/db";
import { resolveDraftExpenseFields } from "~/server/domains/expense/repo/expense-inheritance";
import { resolveDraftEvidenceFields } from "~/server/domains/purchase/repo/purchase-evidence-policy";
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
  /** Saved fields beyond the declared suggestion bases that preview sends as context. */
  contextKeys: readonly string[];
  /** Whether a create must resolve an effective trade. */
  requiresTrade: (draft: Draft) => boolean;
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
    contextKeys: [],
    requiresTrade: (draft) =>
      draft.lineKind === undefined ||
      draft.lineKind === "principal" ||
      draft.lineKind === "auto",
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
    contextKeys: ["assigneeId", "assigneeMode"],
    requiresTrade: () => true,
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

/** The fields any draft policy reads; other keys pass through untouched. */
export const inheritanceDraftSchema = z.looseObject({
  name: z.string().nullable().optional(),
  lineKind: z.string().optional(),
  projectId: z.string().nullable().optional(),
  projectMode: z.string().optional(),
  subjectProductId: z.string().nullable().optional(),
  subjectProductMode: z.string().optional(),
  assigneeId: z.string().nullable().optional(),
  assigneeMode: z.enum(["inherit", "explicit"]).optional(),
  parentTaskId: z.string().nullable().optional(),
  productId: z.string().nullable().optional(),
  purchaseId: z.string().nullable().optional(),
  trade: z.string().nullable().optional(),
});

export function hasDraftPolicy(entity: string): boolean {
  return policyFor(entity) !== undefined;
}

/** Extra saved context keys for a draft entity; undefined without a policy. */
export function draftContextKeys(
  entity: string,
): readonly string[] | undefined {
  return policyFor(entity)?.contextKeys;
}

export function draftRequiresTrade(entity: string, draft: Draft): boolean {
  return policyFor(entity)?.requiresTrade(draft) ?? false;
}

const evidenceEntities = ["purchase", "financialTransaction"] as const;
const isEvidenceEntity = (
  entity: string,
): entity is (typeof evidenceEntities)[number] =>
  evidenceEntities.some((candidate) => candidate === entity);

/**
 * Field suggestions resolve a draft through its inheritance policy, or for an
 * evidence-backed record through its saved source evidence.
 */
export function resolveFieldSuggestionDraft(
  db: Database,
  input: {
    entity: string;
    entityId?: string;
    draft: Readonly<Record<string, string | null>>;
  },
): Promise<FieldResolutions> {
  const inheritance = resolveSuggestionDraft(db, input.entity, {
    ...input.draft,
  });
  if (inheritance) return inheritance;
  if (isEvidenceEntity(input.entity))
    return resolveDraftEvidenceFields(db, {
      entity: input.entity,
      entityId: input.entityId,
      basis: input.draft,
    });
  return Promise.resolve({});
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
