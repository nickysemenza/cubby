import type { Entity } from "@cubby/schemas/entity";
import type { SuggestionListRow } from "@cubby/schemas/suggestion-list";
import { parseShortcode } from "@cubby/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { z } from "zod";

import { renderSuggestedListFieldValue } from "~/entity/display/entity-display";
import { useEntityMetadata } from "~/entity/metadata";
import { suggestion as suggestionApi } from "~/integrations/tanstack-query/generated/domains/suggestion.gen";
import { suggestions } from "~/integrations/tanstack-query/generated/domains/suggestions.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Button } from "~/ui/primitives/button";

import { acceptItem, wrongItem } from "./queue/suggestion-review";
import { useRenderedText } from "./use-rendered-text";

const recordIdSchema = z.object({ id: z.string() });
const entries = z.array(z.json());

/** Entries a removal proposal drops: the current list minus the remaining one. */
function removedEntries(current: unknown, remaining: unknown) {
  const kept = new Set(
    (entries.safeParse(remaining).data ?? []).map((entry) =>
      JSON.stringify(entry),
    ),
  );
  return (entries.safeParse(current).data ?? []).filter(
    (entry) => !kept.has(JSON.stringify(entry)),
  );
}
type FieldRow = Extract<SuggestionListRow, { family: "field" }>;

/** The record's pending field rows; the server lists Disagreements and needs-you only. */
function useRecordFieldRows(entity: Entity, id: string | undefined) {
  const hydrated = useHydrated();
  return useQuery({
    ...suggestions.list.queryOptions({
      family: "field",
      recordIds: id ? [id] : [],
      limit: 50,
    }),
    enabled: hydrated && id !== undefined,
    select: (page) =>
      page.items.filter(
        (row): row is FieldRow =>
          row.family === "field" &&
          row.record.entity === entity &&
          row.record.id === id,
      ),
  });
}

/**
 * A detail fact's value, followed by the field's Disagreement or needs-you
 * row when Cubby has one: "Cubby would pick X · 93% sure", Use X, Keep Y.
 */
export function RecordFieldSuggestion({
  entity,
  record,
  field,
  children,
}: {
  entity: Entity;
  record: unknown;
  field: string;
  children: ReactNode;
}) {
  const parsed = recordIdSchema.safeParse(record);
  const id =
    parsed.success && parseShortcode(parsed.data.id)?.type === entity
      ? parsed.data.id
      : undefined;
  const rows = useRecordFieldRows(entity, id);
  const row = rows.data?.find(
    (candidate) => candidate.evidence.field === field,
  );
  return (
    <span className="grid min-w-0 gap-1">
      <span className="min-w-0">{children}</span>
      {row && id ? <FieldProposal entity={entity} id={id} row={row} /> : null}
    </span>
  );
}

function FieldProposal({
  entity,
  id,
  row,
}: {
  entity: Entity;
  id: string;
  row: FieldRow;
}) {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata(entity);
  const review = useMutation(suggestionApi.review.mutationOptions());
  const proposed = useRenderedText();
  const current = useRenderedText();
  const { evidence } = row;
  const render = (value: unknown) =>
    renderSuggestedListFieldValue(
      queryClient,
      entity,
      { id },
      evidence.field,
      z.json().parse(value),
    );
  const hasCurrent =
    evidence.currentValue !== null && evidence.currentValue !== "";
  const accept = acceptItem(row);
  const keep = wrongItem(row);
  const percent = `${Math.round(evidence.confidence * 100)}%`;
  // A prune field's proposal stores the remaining entries; it names the ones
  // it removes.
  const prune =
    metadata.fields.fields.find((candidate) => candidate.key === evidence.field)
      ?.control?.suggest?.mode === "prune";
  const shown = prune
    ? removedEntries(evidence.currentValue, evidence.suggestedValue)
    : evidence.suggestedValue;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
        {prune ? "Cubby would remove" : "Cubby would pick"}
        <span
          ref={proposed.ref}
          className="inline-flex min-w-0 text-foreground"
        >
          {render(shown)}
        </span>
        · {percent} sure
      </span>
      {/* The current value's text names Keep; it is already shown above. */}
      {hasCurrent ? (
        <span ref={current.ref} hidden>
          {render(evidence.currentValue)}
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1">
        {accept ? (
          <Button
            size="xs"
            variant="outline"
            disabled={review.isPending || review.data?.status === "waiting"}
            onClick={() => review.mutate(accept)}
          >
            {prune ? "Remove" : "Use"} {proposed.text || "this value"}
          </Button>
        ) : null}
        {keep ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={review.isPending || review.data?.status === "waiting"}
            onClick={() => review.mutate(keep)}
          >
            {prune
              ? "Keep all"
              : hasCurrent
                ? `Keep ${current.text || "current value"}`
                : "Not this"}
          </Button>
        ) : null}
      </span>
      <output>
        {review.data?.status === "waiting" ? "Cubby is reworking this" : null}
      </output>
      {review.error ? (
        <ErrorDisplay error={review.error} title="this suggestion" />
      ) : null}
    </span>
  );
}
