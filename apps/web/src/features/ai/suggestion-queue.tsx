import type { SuggestionReviewRow } from "@cubby/schemas/ai";
import { suggestFieldKeys } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { suggestionSweepRunProgress } from "@cubby/schemas/run-fields";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { Stack } from "~/ui/layout";
import { Page } from "~/ui/page/Page";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";

const targetEntity = z.enum(shortcodeEntities);
const sweepFiltersSchema = z.record(z.string(), z.json());
type Entity = z.infer<typeof targetEntity>;
type JsonValue = z.infer<ReturnType<typeof z.json>>;
const targets = suggestFieldKeys.map((key) => {
  const separator = key.indexOf(".");
  return {
    key,
    entity: targetEntity.parse(key.slice(0, separator)),
    field: key.slice(separator + 1),
  };
});
const valueLabel = (value: JsonValue) =>
  value == null ? "—" : JSON.stringify(value);
const readSweepFilters = (raw: string) => {
  try {
    return sweepFiltersSchema.safeParse(JSON.parse(raw));
  } catch {
    return { success: false as const, error: null };
  }
};

function EntityFieldFilters({
  entity,
  field,
  onEntity,
  onField,
  fields,
  allEntities,
}: {
  entity: Entity | "";
  field: string;
  onEntity: (value: Entity | "") => void;
  onField: (value: string) => void;
  fields: typeof targets;
  allEntities: boolean;
}) {
  return (
    <>
      <label className="grid gap-1 text-sm">
        Entity
        <select
          className="rounded-md border bg-background px-2 py-1"
          value={entity}
          onChange={(event) =>
            onEntity(targetEntity.safeParse(event.target.value).data ?? "")
          }
        >
          <option value="">
            {allEntities ? "All entities" : "Choose entity"}
          </option>
          {[...new Set(targets.map((target) => target.entity))].map((key) => (
            <option key={key} value={key}>
              {entitySummary[key].plural}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        Field
        <select
          className="rounded-md border bg-background px-2 py-1"
          value={field}
          onChange={(event) => onField(event.target.value)}
        >
          <option value="">
            {allEntities ? "All fields" : "Choose field"}
          </option>
          {fields.map((target) => (
            <option key={target.key} value={target.field}>
              {target.field}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

export function SuggestionRows({
  rows,
  selected,
  setSelected,
  accept,
  reject,
  busy,
}: {
  rows: readonly SuggestionReviewRow[];
  selected: ReadonlySet<string>;
  setSelected: (update: (previous: Set<string>) => Set<string>) => void;
  accept: (id: string) => void;
  reject: (id: string) => void;
  busy: boolean;
}) {
  return (
    <div className="divide-y rounded-lg border bg-card">
      {rows.map((row) => (
        <div key={row.id} className="flex flex-wrap items-center gap-3 p-3">
          <input
            aria-label={`Select ${row.field} suggestion`}
            type="checkbox"
            checked={selected.has(row.id)}
            onChange={(event) =>
              setSelected((previous) => {
                const next = new Set(previous);
                if (event.target.checked) next.add(row.id);
                else next.delete(row.id);
                return next;
              })
            }
          />
          <div className="min-w-48 flex-1">
            <p className="font-medium">
              {valueLabel(row.currentValue)} <span aria-hidden>→</span>{" "}
              {valueLabel(row.suggestedValue)}
            </p>
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {entitySummary[row.entity].singular} · {row.field}
              <Badge variant="outline">{row.kind}</Badge>
              {Math.round(row.confidence * 100)}%
            </p>
          </div>
          <Button size="sm" disabled={busy} onClick={() => accept(row.id)}>
            Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => reject(row.id)}
          >
            Reject
          </Button>
        </div>
      ))}
    </div>
  );
}

function SweepControls({
  entity,
  field,
  onEntity,
  onField,
}: {
  entity: Entity | "";
  field: string;
  onEntity: (value: Entity | "") => void;
  onField: (value: string) => void;
}) {
  const [filterText, setFilterText] = useState("{}");
  const start = useMutation(ai.startSuggestionSweep.mutationOptions());
  const pause = useMutation(ai.pauseSuggestionSweep.mutationOptions());
  const resume = useMutation(ai.resumeSuggestionSweep.mutationOptions());
  const status = useQuery({
    ...ai.latestSuggestionSweepStatus.queryOptions(),
    refetchInterval: 1000,
  });
  const fields = targets.filter(
    (target) => !entity || target.entity === entity,
  );
  const runId = status.data?.latestRunId;
  const filters = readSweepFilters(filterText);
  const progress = suggestionSweepRunProgress.safeParse(status.data?.progress);
  return (
    <section className="flex flex-wrap items-end gap-2 border-t pt-4">
      <h2 className="w-full text-lg font-semibold">Start sweep</h2>
      <EntityFieldFilters
        entity={entity}
        field={field}
        onEntity={onEntity}
        onField={onField}
        fields={fields}
        allEntities={false}
      />
      <label className="grid w-full gap-1 text-sm">
        Record filters (JSON)
        <textarea
          aria-label="Record filters"
          className="min-h-16 rounded-md border bg-background px-2 py-1 font-mono text-xs"
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          placeholder="{}"
        />
      </label>
      <Button
        disabled={!entity || !field || !filters.success || start.isPending}
        onClick={() => {
          if (entity && filters.success)
            start.mutate({ entity, field, filters: filters.data });
        }}
      >
        {start.isPending ? "Sweeping…" : "Start sweep"}
      </Button>
      {!filters.success && (
        <p role="alert">Enter a valid JSON object for record filters.</p>
      )}
      {runId && status.data?.status === "running" && (
        <>
          <span className="text-sm text-muted-foreground">
            {progress.success
              ? `${progress.data.done} / ${progress.data.total} reviewed · ${progress.data.queued} queued`
              : "Sweep is running"}
          </span>
          {status.data.paused ? (
            <Button variant="outline" onClick={() => resume.mutate({ runId })}>
              Resume
            </Button>
          ) : (
            <Button variant="outline" onClick={() => pause.mutate({ runId })}>
              Pause
            </Button>
          )}
        </>
      )}
      {start.error && <p role="alert">{String(start.error)}</p>}
    </section>
  );
}

function QueuePanel() {
  const [entity, setEntity] = useState<Entity | "">("");
  const [field, setField] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const queue = useQuery(
    ai.listSuggestionReviewQueue.queryOptions({
      entity: entity || undefined,
      field: field || undefined,
      minConfidence: 0.5,
    }),
  );
  const clientRefresh = async () => queue.refetch();
  const accept = useMutation(
    ai.acceptSuggestion.mutationOptions({ onSuccess: clientRefresh }),
  );
  const acceptMany = useMutation(
    ai.acceptSuggestions.mutationOptions({ onSuccess: clientRefresh }),
  );
  const reject = useMutation(
    ai.rejectSuggestion.mutationOptions({ onSuccess: clientRefresh }),
  );
  const busy = accept.isPending || acceptMany.isPending || reject.isPending;
  const fields = targets.filter(
    (target) => !entity || target.entity === entity,
  );
  const acceptSelected = async () => {
    await acceptMany.mutateAsync({ ids: [...selected] });
    setSelected(new Set());
  };
  return (
    <Stack gap="lg">
      <div className="flex flex-wrap items-end gap-2">
        <EntityFieldFilters
          entity={entity}
          field={field}
          onEntity={(value) => {
            setEntity(value);
            setField("");
          }}
          onField={setField}
          fields={fields}
          allEntities
        />
        <Button
          disabled={!selected.size || busy}
          onClick={() => void acceptSelected()}
        >
          Accept selected ({selected.size})
        </Button>
      </div>
      {queue.isLoading ? (
        <p>Loading suggestions…</p>
      ) : queue.isError ? (
        <p role="alert">{String(queue.error)}</p>
      ) : queue.data?.length ? (
        <SuggestionRows
          rows={queue.data}
          selected={selected}
          setSelected={setSelected}
          accept={(id) => accept.mutate({ id })}
          reject={(id) => reject.mutate({ id })}
          busy={busy}
        />
      ) : (
        <p>No pending suggestions match these filters.</p>
      )}
      <SweepControls
        entity={entity}
        field={field}
        onEntity={(value) => {
          setEntity(value);
          setField("");
        }}
        onField={setField}
      />
    </Stack>
  );
}

function MissesPanel() {
  const misses = useQuery(ai.listSuggestionMisses.queryOptions({}));
  if (misses.isLoading) return <p>Loading Misses…</p>;
  if (misses.isError) return <p role="alert">{String(misses.error)}</p>;
  if (!misses.data?.length) return <p>No Misses have been recorded.</p>;
  return (
    <div className="divide-y rounded-lg border bg-card">
      {misses.data.map((miss) => (
        <div
          key={JSON.stringify([miss.entity, miss.field, miss.suggestedValue])}
          className="flex justify-between gap-4 p-3"
        >
          <span>
            {entitySummary[miss.entity].singular} · {miss.field} ·{" "}
            {valueLabel(miss.suggestedValue)}
          </span>
          <span className="tabular-nums">{miss.count}</span>
        </div>
      ))}
    </div>
  );
}

export function SuggestionQueue() {
  const [tab, setTab] = useState<"queue" | "misses">("queue");
  const status = useQuery({
    ...ai.latestSuggestionSweepStatus.queryOptions(),
    refetchInterval: 1000,
  });
  return (
    <Page variant="list" title="Classification review">
      <Stack gap="lg">
        <div className="flex flex-wrap items-center gap-2 border-b pb-3">
          <Button
            variant={tab === "queue" ? "default" : "outline"}
            onClick={() => setTab("queue")}
          >
            Queue
          </Button>
          <Button
            variant={tab === "misses" ? "default" : "outline"}
            onClick={() => setTab("misses")}
          >
            Misses
          </Button>
          <span className="ml-auto text-sm text-muted-foreground">
            {!status.data?.latestRunId
              ? "No previous sweep"
              : status.data.taxonomyChanged
                ? "Taxonomy changed since last sweep"
                : "Taxonomy matches last sweep"}
          </span>
        </div>
        {tab === "queue" ? <QueuePanel /> : <MissesPanel />}
      </Stack>
    </Page>
  );
}
