import type { FinancialTransactionKind } from "@cubby/schemas/financial-transaction";
import type { SuggestionListRow } from "@cubby/schemas/suggestion-list";
import { getErrorMessage } from "@cubby/shared";
import { useQueryClient } from "@tanstack/react-query";
import { chunk } from "es-toolkit";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { assessment } from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";

import type {
  ReviewItem,
  StatementChoice,
  StatementTransactionField,
} from "./suggestion-review";

/** `assessment.reviewBatch` takes at most this many items per call. */
const REVIEW_BATCH_MAX = 100;

type RowOutcome = { state: "pending" } | { state: "failed"; error: string };

/** A failed review, kept with the row as it was so the error has a home after a refetch drops it. */
type ReviewFailure = { row: SuggestionListRow; error: string };

/** A statement row's draft alternatives, shared by its actions menu and its evidence. */
type StatementDraft = {
  kind?: FinancialTransactionKind;
  /** Ticked "apply" fields per candidate transaction. */
  fields: Readonly<Record<string, readonly StatementTransactionField[]>>;
};
const EMPTY_DRAFT: StatementDraft = { fields: {} };

type ReviewContext = {
  outcome: (id: string) => RowOutcome | undefined;
  failures: readonly ReviewFailure[];
  clearFailures: () => void;
  /** Reviews each row that `build` makes an item for; resolves with the failures. */
  review: (
    rows: readonly SuggestionListRow[],
    build: (row: SuggestionListRow) => ReviewItem | null,
  ) => Promise<ReviewFailure[]>;
  draft: (id: string) => StatementDraft;
  setDraft: (id: string, patch: Partial<StatementDraft>) => void;
  /** The recommended choice with the row's draft folded in. */
  statementChoice: (row: SuggestionListRow) => StatementChoice | undefined;
  isOpen: (id: string) => boolean;
  toggleOpen: (id: string, open?: boolean) => void;
  openIds: ReadonlySet<string>;
};

const Context = createContext<ReviewContext | null>(null);

type ReviewState = {
  scope: string;
  outcomes: Map<string, RowOutcome>;
  failures: ReviewFailure[];
  drafts: Map<string, StatementDraft>;
  open: Set<string>;
};
const freshState = (scope: string): ReviewState => ({
  scope,
  outcomes: new Map(),
  failures: [],
  drafts: new Map(),
  open: new Set(),
});

export function useSuggestionReview(): ReviewContext {
  const context = useContext(Context);
  if (!context)
    throw new Error("useSuggestionReview needs a SuggestionReviewProvider");
  return context;
}

/**
 * Review state for one Suggestions view: per-row outcomes, raw failures,
 * statement drafts and open evidence rows. `scope` is the view's query;
 * changing it starts a fresh visit with nothing open and no old failures.
 */
export function SuggestionReviewProvider({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ReviewState>(() => freshState(scope));
  if (state.scope !== scope) setState(freshState(scope));

  const review = useCallback<ReviewContext["review"]>(
    async (rows, build) => {
      const pairs = rows.flatMap((row) => {
        const item = build(row);
        return item ? [{ row, item }] : [];
      });
      if (!pairs.length) return [];
      setState((previous) => {
        const outcomes = new Map(previous.outcomes);
        for (const { row } of pairs) outcomes.set(row.id, { state: "pending" });
        return { ...previous, outcomes };
      });
      const failures: ReviewFailure[] = [];
      for (const batch of chunk(pairs, REVIEW_BATCH_MAX)) {
        try {
          const results = await assessment.reviewBatch.call({
            items: batch.map(({ item }) => item),
          });
          for (const [index, result] of results.entries()) {
            const pair = batch[index];
            if (pair && !result.ok)
              failures.push({ row: pair.row, error: result.error });
          }
        } catch (error) {
          const message = getErrorMessage(error);
          failures.push(...batch.map(({ row }) => ({ row, error: message })));
        }
      }
      const failed = new Map(
        failures.map((failure) => [failure.row.id, failure]),
      );
      setState((previous) => {
        const outcomes = new Map(previous.outcomes);
        for (const { row } of pairs) {
          const failure = failed.get(row.id);
          if (failure)
            outcomes.set(row.id, { state: "failed", error: failure.error });
          else outcomes.delete(row.id);
        }
        return {
          ...previous,
          outcomes,
          failures: [
            ...previous.failures.filter(
              (failure) => !failed.has(failure.row.id),
            ),
            ...failures,
          ],
        };
      });
      await invalidateOperationTags(
        queryClient,
        assessment.reviewBatch.invalidates({
          items: pairs.map(({ item }) => item),
        }),
      );
      return failures;
    },
    [queryClient],
  );

  const value = useMemo<ReviewContext>(() => {
    const draft = (id: string) => state.drafts.get(id) ?? EMPTY_DRAFT;
    return {
      outcome: (id) => state.outcomes.get(id),
      failures: state.failures,
      clearFailures: () =>
        setState((previous) => ({ ...previous, failures: [] })),
      review,
      draft,
      setDraft: (id, patch) =>
        setState((previous) => {
          const drafts = new Map(previous.drafts);
          drafts.set(id, { ...(drafts.get(id) ?? EMPTY_DRAFT), ...patch });
          return { ...previous, drafts };
        }),
      statementChoice: (row) => {
        if (row.family !== "statement_transaction") return undefined;
        const suggestion = row.evidence;
        const current = draft(row.id);
        const first = suggestion.candidates[0]?.transactionId;
        return suggestion.recommended === "attach"
          ? {
              action: "attach",
              transactionId: first,
              fields: first ? [...(current.fields[first] ?? [])] : [],
            }
          : { action: suggestion.recommended, kindOverride: current.kind };
      },
      isOpen: (id) => state.open.has(id),
      toggleOpen: (id, open) =>
        setState((previous) => {
          const next = new Set(previous.open);
          if (open ?? !next.has(id)) next.add(id);
          else next.delete(id);
          return { ...previous, open: next };
        }),
      openIds: state.open,
    };
  }, [state, review]);
  return <Context value={value}>{children}</Context>;
}
