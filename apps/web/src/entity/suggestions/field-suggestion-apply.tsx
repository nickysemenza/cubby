import type { FieldSuggestion } from "@cubby/schemas/ai";
import type { FieldGuess } from "@cubby/schemas/field-authority";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { z } from "zod";

import { renderSuggestedListFieldValue } from "~/entity/display/entity-display";
import { useEntityMetadata } from "~/entity/metadata";
import { suggestion as suggestionApi } from "~/integrations/tanstack-query/generated/domains/suggestion.gen";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { useHydrated } from "~/ui/hooks/use-hydrated";

import {
  type FieldSuggestionSource,
  useEntitySuggestionsQuery,
} from "./field-suggestion";
import { FieldSuggestionHint } from "./field-suggestion-hint";
import { GUESS_GROUP } from "./use-auto-field-suggestion";

/** Parsed while disabled; never fetched. */
const INACTIVE = {
  entity: "product",
  id: "PRD-0",
  field: "__inactive__",
} as const;
const stringValue = z.string().min(1);
const NO_IDS: readonly string[] = [];

type GuessRow = { id: string; confidence: number };

const chip = (confidence: number) => {
  const percent = `${Math.round(confidence * 100)}%`;
  return { text: percent, spoken: `Cubby's guess, ${percent} sure` };
};

interface FieldGuessRows {
  guess: FieldGuess | null;
  /** The guess and its stored runner-up, guess first. */
  ids: readonly string[];
  /** Fixed options with the guess rows pinned first. */
  pinOptions: (options: readonly PickerOption[]) => PickerOption[];
  /** Record rows with the guess rows pinned first; missing rows are seeded by id. */
  pinItems: <TId extends string>(
    items: readonly ComboboxItem<TId>[],
  ) => ComboboxItem<TId>[];
  /** Whether a picked value is Cubby's guess, which saves as an accept. */
  isGuess: (value: string | null | undefined) => boolean;
  accept: () => Promise<void>;
}

/**
 * Cubby's stored guess for one saved field, read when its editor opens. The
 * editor pins it as the first "Cubby's guess" group; picking it accepts the
 * Suggestion, and picking any other value is an ordinary edit, which the
 * server records as the correction. No model call is made.
 */
export function useFieldGuess(
  source: FieldSuggestionSource | null | undefined,
): FieldGuessRows {
  const hydrated = useHydrated();
  const field = source?.targets[0];
  const id = source?.entityId;
  const input =
    hydrated && source && id && field
      ? { entity: source.entity, id, field }
      : null;
  const enabled = input !== null;
  const options = suggestionApi.fieldGuess.queryOptions(input ?? INACTIVE);
  const query = useQuery({
    ...options,
    enabled,
    meta: { ...options.meta, silentErrors: true },
  });
  // A mutation, not a bare call, so the contract's invalidation refreshes the row.
  const review = useMutation(suggestionApi.review.mutationOptions());
  const guess = (enabled ? query.data?.guess : null) ?? null;
  const rows = useMemo<GuessRow[]>(() => {
    const winner = stringValue.safeParse(guess?.value).data;
    if (!guess || !winner) return [];
    const runnerUp = stringValue.safeParse(guess.runnerUp?.value).data;
    return [
      { id: winner, confidence: guess.confidence },
      ...(runnerUp && guess.runnerUp && runnerUp !== winner
        ? [{ id: runnerUp, confidence: guess.runnerUp.confidence }]
        : []),
    ];
  }, [guess]);
  const ids = useMemo(
    () => (rows.length ? rows.map((row) => row.id) : NO_IDS),
    [rows],
  );
  const pinOptions = useCallback(
    (options: readonly PickerOption[]) => {
      if (!rows.length) return [...options];
      return options.map((option) => {
        const row = rows.find((candidate) => candidate.id === option.value);
        if (!row) return option;
        const { text, spoken } = chip(row.confidence);
        return {
          ...option,
          group: GUESS_GROUP,
          hint: text,
          hintSpoken: spoken,
        };
      });
    },
    [rows],
  );
  const pinItems = useCallback(
    <TId extends string>(items: readonly ComboboxItem<TId>[]) => {
      if (!rows.length) return [...items];
      const pinned = rows.map((row): ComboboxItem<TId> => {
        const known = items.find((item) => item.id === row.id);
        // SAFETY: a guess for a reference field is a shortcode of the
        // picker's own entity, which is the picker's `TId`.
        const base = known ?? {
          id: row.id as TId,
          shortcode: row.id,
          name: row.id,
        };
        return {
          ...base,
          presentation: {
            ...base.presentation,
            group: GUESS_GROUP,
            trailing: [chip(row.confidence)],
          },
        };
      });
      return [...pinned, ...items.filter((item) => !ids.includes(item.id))];
    },
    [rows, ids],
  );
  const winnerId = rows[0]?.id;
  const suggestionId = guess?.suggestionId;
  const { mutateAsync } = review;
  const accept = useCallback(async () => {
    if (!suggestionId) throw new Error("Cubby's guess is no longer available");
    await mutateAsync({
      suggestionId,
      operationId: crypto.randomUUID(),
      verdict: "correct",
      intent: "apply",
      correction: { present: false },
    });
  }, [suggestionId, mutateAsync]);
  const isGuess = useCallback(
    (value: string | null | undefined) =>
      winnerId !== undefined && value === winnerId,
    [winnerId],
  );
  return {
    guess,
    ids,
    pinOptions,
    pinItems,
    isGuess,
    accept,
  };
}

/**
 * A live proposal for an unsaved draft with no RHF form (a split-expense
 * part). Saved records read Cubby's stored guess through `useFieldGuess`.
 */
export function DraftFieldSuggestion({
  source,
  currentValue,
  onApply,
}: {
  source: FieldSuggestionSource;
  currentValue: string | null;
  onApply: (suggestion: FieldSuggestion) => void;
}) {
  useEntityMetadata(source.entity);
  const queryClient = useQueryClient();
  const { suggestions, outcomes, isFetching } = useEntitySuggestionsQuery({
    source,
  });
  const target = source.targets[0];
  const suggestion = target ? (suggestions[target] ?? null) : null;
  return (
    <FieldSuggestionHint
      renderValue={
        target
          ? (value, label) =>
              renderSuggestedListFieldValue(
                queryClient,
                source.entity,
                { id: "" },
                target,
                value,
                label,
              )
          : undefined
      }
      currentValue={currentValue}
      questionKey={JSON.stringify(source)}
      suggestion={suggestion}
      applied={Boolean(suggestion?.value && currentValue === suggestion.value)}
      pending={isFetching}
      onApply={
        suggestion
          ? async () => {
              if (suggestion.suggestionId)
                await suggestionApi.review.call({
                  suggestionId: suggestion.suggestionId,
                  operationId: crypto.randomUUID(),
                  verdict: "correct",
                  intent: "draft",
                });
              onApply(suggestion);
            }
          : undefined
      }
      outcome={target ? (outcomes[target] ?? null) : null}
      surface="line"
    />
  );
}
