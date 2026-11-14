import { auditEntitySchema } from "@cubby/schemas/audit";
import { entityRoster } from "@cubby/schemas/entity-roster";
import { suggestionFamily } from "@cubby/schemas/suggestion";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AuditLogList } from "~/entity/audit-log/audit-log-list";
import { suggestion } from "~/integrations/tanstack-query/generated/domains/suggestion.gen";
import { suggestions } from "~/integrations/tanstack-query/generated/domains/suggestions.gen";
import { Picker } from "~/ui/combobox/picker";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Button } from "~/ui/primitives/button";

import { RecordLink } from "./suggestion-values";

/** The audit provenance is the source for Cubby's changes, scoped like history. */
export function AutomaticChanges({
  record,
  auditFamily,
}: {
  record?: string;
  auditFamily?: string;
}) {
  const [family, setFamily] = useState<string | null>(auditFamily ?? null);
  const [entity, setEntity] = useState<string | null>(null);
  return (
    <section aria-label="Changes by Cubby" className="grid gap-2">
      <Picker
        mode="choose"
        label="Change family"
        placeholder="All changes"
        clearable
        options={suggestionFamily.options
          .filter((value) => value !== "recommendation")
          .map((value) => ({
            value,
            label: suggestionReviewFamilies[value].label,
          }))}
        value={family}
        onValueChange={setFamily}
      />
      <Picker
        mode="choose"
        label="Record kind"
        placeholder="All changes"
        clearable
        options={auditEntitySchema.options.map((value) => ({
          value,
          label: entityRoster[value].singular,
        }))}
        value={entity}
        onValueChange={setEntity}
      />
      {!family || family === "field" ? (
        <AuditLogList
          cubbyChanges
          channel="system"
          entityKind={auditEntitySchema.safeParse(entity).data}
          entityId={record}
        />
      ) : null}
      {family !== "field" ? (
        <AutomaticDecisionHistory
          family={suggestionFamily.safeParse(family).data}
          record={record}
        />
      ) : null}
    </section>
  );
}

/** Non-field automatic outcomes retain their family filter and evidence. */
function AutomaticDecisionHistory({
  family,
  record,
}: {
  family?: import("zod").z.infer<typeof suggestionFamily>;
  record?: string;
}) {
  const [offset, setOffset] = useState(0);
  const read = useQuery(
    suggestions.automaticDecisions.queryOptions({
      family,
      recordIds: record ? [record] : undefined,
      reviewStatus: "all",
      offset,
      limit: 50,
    }),
  );
  return (
    <div className="grid gap-2">
      {read.error ? (
        <ErrorDisplay error={read.error} title="automatic decisions" />
      ) : null}
      {read.data?.items.map((row) => (
        <AutomaticHistoryRow key={row.id} row={row} />
      ))}
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="ghost"
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          Previous
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={read.data?.nextOffset == null}
          onClick={() => setOffset(read.data?.nextOffset ?? offset)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function AutomaticHistoryRow({
  row,
}: {
  row: import("zod").z.infer<
    typeof import("@cubby/schemas/automatic-decision").automaticDecisionRow
  >;
}) {
  const review = useMutation(suggestion.review.mutationOptions());
  return (
    <div className="border-b border-border py-2 text-sm">
      <p>
        {row.records.map((ref) => (
          <RecordLink key={`${ref.entity}:${ref.id}`} record={ref} />
        ))}
      </p>
      <p>{row.summary}</p>
      <details>
        <summary>Evidence</summary>
        <pre className="text-xs break-words whitespace-pre-wrap">
          {JSON.stringify(row.decision, null, 2)}
        </pre>
      </details>
      <Button
        size="xs"
        variant="ghost"
        disabled={
          review.isPending || review.isSuccess || row.verdict === "wrong"
        }
        onClick={() =>
          review.mutate({
            suggestionId: row.id,
            operationId: crypto.randomUUID(),
            verdict: "wrong",
            intent: "history",
            expectedFingerprint: row.fingerprint ?? undefined,
          })
        }
      >
        Report incorrect
      </Button>
      {review.error ? (
        <ErrorDisplay
          error={review.error}
          title="automatic decision feedback"
        />
      ) : null}
    </div>
  );
}
