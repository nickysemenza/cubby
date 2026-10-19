import { formatConfidence, type DecisionCatalogRow } from "@cubby/schemas/ai";
import { aiSmokeRunOut } from "@cubby/schemas/ai-smoke";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { ListGroupSummary } from "@cubby/schemas/pagination";
import { getErrorMessage, humanize } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";

import { EntityIcon } from "~/entity/entities";
import type { StandardEntity } from "~/entity/entity-contracts";
import { entityDetailFor } from "~/entity/entity-detail";
import RTable from "~/entity/table/table";
import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCount } from "~/lib/number-format";
import { Picker } from "~/ui/combobox/picker";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import type { GroupConfig } from "~/ui/data-table/use-grouped-list";
import { Row, Stack } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Input } from "~/ui/primitives/input";
import { NoneValue } from "~/ui/primitives/none-value";

import {
  fieldSuggestionBasisFromRecord,
  suggestTargetsFor,
} from "../../entity/suggestions/field-suggestion";

const helper = createCubbyColumnHelper<DecisionCatalogRow>();
const TRIAL_MODELS = ["typesafe/jev", "@cf/cloudflare/clef"] as const;
type TrialModel = (typeof TRIAL_MODELS)[number];
type TryResult = z.infer<typeof aiSmokeRunOut>;
const fieldSuggestionsResultSchema = z
  .object({
    suggestions: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const decisionScope = (row: DecisionCatalogRow) =>
  row.entity ? entitySummary[row.entity].singular : "Feature";

const ENTITY_CHOICE: GroupConfig["choice"] = {
  key: "entity",
  label: "Entity",
  noValueLabel: "Feature",
  reason: null,
  value: { kind: "derived", options: null },
  filter: null,
  levels: 0,
  levelReason: "Entity is a catalog section, not a hierarchy.",
};

/** Accepted over reviewed (accepted + Misses); null before any review. */
function acceptRate(row: DecisionCatalogRow) {
  const counts = row.counts;
  if (!counts) return null;
  const reviewed = counts.applied + counts.rejected;
  return reviewed === 0 ? null : counts.applied / reviewed;
}

/** Pending outcomes, linked to their review queue when a field owns them. */
function PendingLink({ row }: { row: DecisionCatalogRow }) {
  if (!row.counts) return <NoneValue />;
  const pending = row.counts.pending;
  if (pending === 0 || !row.entity || !row.field)
    return (
      <span className="text-muted-foreground">{formatCount(pending)}</span>
    );
  return (
    <Link
      to="/suggestions"
      search={{ family: "field", entity: row.entity, field: row.field }}
      onClick={(event) => event.stopPropagation()}
      className="font-medium text-info underline-offset-2 hover:underline"
    >
      {formatCount(pending)}
    </Link>
  );
}

/** The accept rate as a number and a bar; Misses tint the remainder. */
function AcceptRateBar({ row }: { row: DecisionCatalogRow }) {
  const rate = acceptRate(row);
  if (rate === null) return <NoneValue />;
  const reviewed = (row.counts?.applied ?? 0) + (row.counts?.rejected ?? 0);
  return (
    <span
      className="inline-flex w-full items-center justify-end gap-1.5"
      title={`${formatCount(row.counts?.applied ?? 0)} of ${formatCount(reviewed)} reviewed accepted`}
    >
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-destructive-surface">
        <span
          className="block h-full rounded-full bg-positive"
          style={{ width: `${Math.round(rate * 100)}%` }}
        />
      </span>
      <span className="w-9 text-right tabular-nums">
        {Math.round(rate * 100)}%
      </span>
    </span>
  );
}

function catalogColumns() {
  return createCubbyColumnCollection<DecisionCatalogRow>((add) => {
    add(
      helper.accessor((row) => row.label, {
        id: "decision",
        header: "Decision",
        size: 220,
        enableSorting: false,
        meta: attachCubbyColumnMeta<DecisionCatalogRow>({
          entityColumnRole: "identity",
          mobile: { slot: "title" },
        }),
        cell: ({ row }) => (
          <span className="font-medium">{row.original.label}</span>
        ),
      }),
    );
    add(
      helper.accessor(decisionScope, {
        id: "scope",
        header: "Entity",
        size: 128,
        enableSorting: false,
        meta: attachCubbyColumnMeta<DecisionCatalogRow>({
          mobile: { slot: "meta", priority: 0, label: "Entity" },
        }),
        cell: ({ row }) => (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {row.original.entity ? (
              <EntityIcon
                entity={row.original.entity}
                colored
                aria-hidden="true"
                className="size-3.5 shrink-0"
              />
            ) : null}
            <span className="truncate">{decisionScope(row.original)}</span>
          </span>
        ),
      }),
    );
    add(
      helper.accessor((row) => row.choiceKind, {
        id: "choiceKind",
        header: "Mode",
        size: 96,
        enableSorting: false,
        meta: attachCubbyColumnMeta<DecisionCatalogRow>({
          mobile: { slot: "meta", priority: 2, label: "Mode" },
        }),
        cell: ({ row }) => (
          <Badge variant="outline" className="font-normal">
            {row.original.roster
              ? `${row.original.choiceKind} · roster`
              : row.original.choiceKind}
          </Badge>
        ),
      }),
    );
    add(
      helper.accessor((row) => row.basis.map((item) => item.label).join(", "), {
        id: "basis",
        header: "Basis",
        size: 220,
        enableSorting: false,
        meta: attachCubbyColumnMeta<DecisionCatalogRow>({
          mobile: { slot: "subtitle", priority: 0, label: "Basis" },
        }),
      }),
    );
    add(
      helper.accessor((row) => row.options.length, {
        id: "options",
        header: "Options",
        size: 80,
        enableSorting: false,
        meta: attachCubbyColumnMeta<DecisionCatalogRow>({
          mobile: { slot: "meta", priority: 3, label: "Options" },
        }),
        cell: ({ row }) =>
          row.original.roster
            ? "live"
            : formatCount(row.original.options.length),
      }),
    );
    add(
      helper.accessor((row) => row.counts?.pending ?? null, {
        id: "pending",
        header: "Pending",
        size: 80,
        enableSorting: false,
        meta: attachCubbyColumnMeta<DecisionCatalogRow>({
          mobile: { slot: "meta", priority: 1, label: "Pending" },
        }),
        cell: ({ row }) => <PendingLink row={row.original} />,
      }),
    );
    add(
      helper.accessor(acceptRate, {
        id: "acceptRate",
        header: "Accept rate",
        size: 120,
        enableSorting: false,
        meta: attachCubbyColumnMeta<DecisionCatalogRow>({
          numeric: true,
          mobile: { slot: "meta", priority: 2, label: "Accept rate" },
        }),
        cell: ({ row }) => <AcceptRateBar row={row.original} />,
      }),
    );
    add(
      helper.accessor((row) => row.counts?.applied ?? null, {
        id: "applied",
        header: "Accepted",
        size: 80,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.counts ? formatCount(row.original.counts.applied) : "—",
      }),
    );
    add(
      helper.accessor((row) => row.counts?.rejected ?? null, {
        id: "rejected",
        header: "Misses",
        size: 80,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.counts ? formatCount(row.original.counts.rejected) : "—",
      }),
    );
    add(
      helper.accessor((row) => row.model, {
        id: "model",
        header: "Model",
        size: 160,
        enableSorting: false,
        meta: attachCubbyColumnMeta<DecisionCatalogRow>({
          mobile: { slot: "meta", priority: 4, label: "Model" },
        }),
        cell: ({ row }) => (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {row.original.model}
          </span>
        ),
      }),
    );
  });
}

function TryOutcome({
  model,
  result,
}: {
  model: TrialModel;
  result: TryResult;
}) {
  const parsed = fieldSuggestionsResultSchema.safeParse(result.result);
  const suggestions = parsed.success
    ? Object.values(parsed.data.suggestions)
    : [];
  const [first] = suggestions;
  const suggestion = z
    .object({
      label: z.string().nullable(),
      value: z.string().nullable(),
      probability: z.number().nullable(),
      confidence: z.enum(["high", "medium", "low"]),
      alternatives: z.array(
        z.object({ label: z.string(), probability: z.number() }).passthrough(),
      ),
    })
    .passthrough()
    .safeParse(first);
  return (
    <Stack gap="xs" className="min-w-0 flex-1 rounded-md border p-2 text-xs">
      <span className="font-medium">{model}</span>
      {result.error ? (
        <Description size="xs" role="alert">
          {result.error}
        </Description>
      ) : suggestion.success && suggestion.data.value !== null ? (
        <>
          <span className="text-primary">
            {suggestion.data.label ?? suggestion.data.value} ·{" "}
            {formatConfidence(
              suggestion.data.probability,
              suggestion.data.confidence,
            )}
          </span>
          {suggestion.data.alternatives[0] ? (
            <span className="text-muted-foreground">
              Runner-up: {suggestion.data.alternatives[0].label} ·{" "}
              {formatConfidence(suggestion.data.alternatives[0].probability)}
            </span>
          ) : null}
        </>
      ) : (
        <span className="text-muted-foreground">
          {result.status === "no_model_call"
            ? "Not asked — the basis gave nothing to go on"
            : "No suggestion"}
        </span>
      )}
      <Link
        to="/runs/$shortcode"
        params={{ shortcode: result.runShortcode }}
        className="text-muted-foreground underline-offset-2 hover:underline"
      >
        {result.runShortcode}
      </Link>
    </Stack>
  );
}

/** Runs one record's basis through Jev and Clef with the smoke runner,
 * pinning each model through `decisionModel`. */
function TryPanel({ row }: { row: DecisionCatalogRow }) {
  const entity = row.entity;
  const field = row.field;
  const [recordId, setRecordId] = useState("");
  const [basis, setBasis] = useState<Record<string, string>>({});
  const [results, setResults] = useState<
    Partial<Record<TrialModel, TryResult>>
  >({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!entity || !field) return null;
  const loadRecord = async () => {
    setError(null);
    try {
      const record = await entityDetailFor(
        // SAFETY: catalog field rows name a generated manifest entity with
        // a detail read (every `suggestFieldKeys` entity is browser-routed).
        entity as StandardEntity,
      ).readFresh(recordId.trim());
      if (!record) throw new Error(`Record ${recordId} was not found.`);
      const loaded = fieldSuggestionBasisFromRecord(
        entity,
        suggestTargetsFor(entity, [field]),
        record,
      );
      setBasis(
        Object.fromEntries(
          Object.entries(loaded).flatMap(([key, value]) =>
            value === null ? [] : [[key, value]],
          ),
        ),
      );
    } catch (failure) {
      setError(getErrorMessage(failure));
    }
  };
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const { runAiSmokeCase } =
        await import("~/features/ai/server-functions/ai-smoke");
      const settled = await Promise.all(
        TRIAL_MODELS.map(async (decisionModel) => {
          const output = await runAiSmokeCase({
            data: {
              scenario: "fieldSuggestions",
              input: {
                entity,
                targets: [field],
                basisMode: "provided",
                basis,
                decisionModel,
                ...(recordId.trim() ? { entityId: recordId.trim() } : {}),
              },
            },
          });
          return [decisionModel, aiSmokeRunOut.parse(output)] as const;
        }),
      );
      setResults(Object.fromEntries(settled));
    } catch (failure) {
      setError(getErrorMessage(failure));
    } finally {
      setRunning(false);
    }
  };
  return (
    <Stack gap="sm">
      <h3 className="text-sm font-medium">Try</h3>
      <Row gap="xs" wrap align="center">
        <Input
          aria-label="Record code"
          placeholder={`${entitySummary[entity].singular} code (optional)`}
          className="w-48"
          value={recordId}
          onChange={(event) => setRecordId(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!recordId.trim()}
          onClick={() => void loadRecord()}
        >
          Load basis
        </Button>
      </Row>
      {row.basis.map((item) => (
        <label key={item.key} className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{item.label}</span>
          <Input
            value={basis[item.key] ?? ""}
            onChange={(event) =>
              setBasis((previous) => ({
                ...previous,
                [item.key]: event.target.value,
              }))
            }
          />
        </label>
      ))}
      <Row gap="xs" align="center">
        <Button
          type="button"
          size="sm"
          disabled={running}
          onClick={() => void run()}
        >
          {running ? "Running…" : "Run Jev and Clef"}
        </Button>
        <Description size="xs" className="text-muted-foreground">
          Each run is a recorded Run with billed AI usage.
        </Description>
      </Row>
      {error ? (
        <Description size="xs" role="alert">
          {error}
        </Description>
      ) : null}
      <Row gap="sm" wrap>
        {TRIAL_MODELS.map((model) => {
          const result = results[model];
          return result ? (
            <TryOutcome key={model} model={model} result={result} />
          ) : null;
        })}
      </Row>
    </Stack>
  );
}

function DecisionDetail({ row }: { row: DecisionCatalogRow }) {
  return (
    <Stack gap="md" className="text-sm">
      {row.description ? <p>{row.description}</p> : null}
      <Description size="xs" className="text-muted-foreground">
        {row.feature} · {row.model} · prompt {row.promptVersion}
        {row.reviewRequired ? " · review required" : ""}
      </Description>
      {row.counts ? (
        <p className="tabular-nums">
          {formatCount(row.counts.pending)} pending ·{" "}
          {formatCount(row.counts.applied)} accepted ·{" "}
          {formatCount(row.counts.rejected)} Misses ·{" "}
          {formatCount(row.counts.superseded)} superseded
          {row.counts.pending > 0 && row.entity && row.field ? (
            <>
              {" · "}
              <Link
                to="/suggestions"
                search={{
                  family: "field",
                  entity: row.entity,
                  field: row.field,
                }}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                Review {formatCount(row.counts.pending)} pending
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {row.basis.length > 0 ? (
        <section>
          <h3 className="text-sm font-medium">Basis</h3>
          <p>{row.basis.map((item) => item.label).join(", ")}</p>
        </section>
      ) : null}
      <section>
        <h3 className="text-sm font-medium">Options</h3>
        {row.roster ? (
          <p className="text-muted-foreground">
            A live roster of up to {formatCount(row.roster.maxCandidates)}{" "}
            {row.roster.entity
              ? `${humanize(row.roster.entity).toLowerCase()} records`
              : "candidates"}{" "}
            chosen per record; Try shows a real one.
          </p>
        ) : (
          <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-3 gap-y-1 text-xs">
            {row.options.map((option) => (
              <div key={option.value} className="contents">
                <dt className="font-medium">{option.label}</dt>
                <dd className="text-muted-foreground">
                  {option.description ?? option.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <section>
        <h3 className="text-sm font-medium">Rules</h3>
        <p className="whitespace-pre-wrap text-muted-foreground">
          {row.rules || "No extra rules."}
        </p>
      </section>
      <section>
        <h3 className="text-sm font-medium">Prompt subject (synthetic)</h3>
        <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
          {row.prompt.subject}
        </pre>
      </section>
      <section>
        <h3 className="text-sm font-medium">Request input</h3>
        <pre className="max-h-80 overflow-auto rounded-md bg-muted p-2 text-xs">
          {JSON.stringify(row.prompt.input, null, 2)}
        </pre>
      </section>
      {row.field ? <TryPanel row={row} /> : null}
    </Stack>
  );
}

/**
 * The Decisions tab: every Jev/Clef decision with its basis, options, rules,
 * rendered request and stored outcomes. Email relevance accuracy stays an
 * Emails view, linked here.
 */
export function DecisionsCatalog({
  selected,
  onSelect,
}: {
  selected: string | undefined;
  onSelect: (key: string | undefined) => void;
}) {
  const catalog = useQuery(ai.decisionCatalog.queryOptions(undefined));
  const [query, setQuery] = useState("");
  const [grouped, setGrouped] = useState(true);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = (catalog.data ?? []).filter(
      (row) =>
        !needle ||
        [row.label, row.key, decisionScope(row), row.model, row.feature].some(
          (text) => text.toLowerCase().includes(needle),
        ),
    );
    // Sections take consecutive rows, so grouping orders by entity first.
    return grouped
      ? [...matching].sort((a, b) =>
          decisionScope(a).localeCompare(decisionScope(b)),
        )
      : matching;
  }, [catalog.data, query, grouped]);
  const groupConfig = useMemo<GroupConfig | undefined>(() => {
    if (!grouped) return undefined;
    const groups: ListGroupSummary[] = [];
    for (const row of rows) {
      const label = decisionScope(row);
      const last = groups.at(-1);
      if (last?.label === label) last.count += 1;
      else groups.push({ key: row.entity ?? "feature", label, count: 1 });
    }
    return {
      choice: ENTITY_CHOICE,
      groups,
      header: (group) => {
        const entity = rows.find(
          (row) => (row.entity ?? "feature") === group.key,
        )?.entity;
        return entity
          ? {
              aside: (
                <EntityIcon
                  entity={entity}
                  colored
                  aria-hidden="true"
                  className="size-3.5"
                />
              ),
            }
          : {};
      },
    };
  }, [grouped, rows]);
  const columns = useMemo(() => catalogColumns(), []);
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const table = useCubbyTable({
    data: rows,
    columns: tableColumns,
    meta: { defaultLayout },
    getRowId: (row) => row.key,
    enableSorting: false,
    enableFilters: false,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
  });
  const current = rows.find((row) => row.key === selected);
  const totals = (catalog.data ?? []).reduce(
    (sum, row) => ({
      pending: sum.pending + (row.counts?.pending ?? 0),
      applied: sum.applied + (row.counts?.applied ?? 0),
      rejected: sum.rejected + (row.counts?.rejected ?? 0),
    }),
    { pending: 0, applied: 0, rejected: 0 },
  );
  const reviewed = totals.applied + totals.rejected;
  return (
    <Stack gap="sm">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label="Search decisions"
          placeholder="Search decisions, entities, models"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-7 w-64 text-xs"
        />
        <Picker
          mode="segmented"
          label="Group"
          options={[
            { value: "entity", label: "By entity" },
            { value: "none", label: "No groups" },
          ]}
          value={grouped ? "entity" : "none"}
          onValueChange={(value) => setGrouped(value === "entity")}
        />
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {formatCount(rows.length)} decisions · {formatCount(totals.pending)}{" "}
          pending
          {reviewed > 0
            ? ` · ${Math.round((totals.applied / reviewed) * 100)}% accepted`
            : ""}
        </span>
      </div>
      <Description size="xs" className="text-muted-foreground">
        Jev and Clef return no reasoning, so each decision shows what the model
        reads and how its suggestions were reviewed. Email relevance is measured
        in{" "}
        <Link
          to="/emails"
          search={{ view: "accuracy" }}
          className="underline-offset-2 hover:underline"
        >
          Emails · Accuracy
        </Link>
        .
      </Description>
      <RTable
        table={table}
        ariaLabel="Decisions"
        isLoading={catalog.isLoading}
        error={catalog.error}
        embedded
        groupConfig={groupConfig}
        onRowClick={(row) => onSelect(row.original.key)}
        currentRowId={selected}
        emptyState={
          query
            ? "No decision matches that search."
            : "No decisions are declared."
        }
      />
      <Overlay
        placement="panel"
        open={current !== undefined}
        onOpenChange={(open) => {
          if (!open) onSelect(undefined);
        }}
        title={current?.label ?? "Decision"}
        description={current?.key}
      >
        {current ? <DecisionDetail row={current} /> : null}
      </Overlay>
    </Stack>
  );
}
