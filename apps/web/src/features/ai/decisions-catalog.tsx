import { formatConfidence, type DecisionCatalogRow } from "@cubby/schemas/ai";
import { aiSmokeRunOut } from "@cubby/schemas/ai-smoke";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { getErrorMessage, humanize } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";

import type { StandardEntity } from "~/entity/entity-contracts";
import { entityDetailFor } from "~/entity/entity-detail";
import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCount } from "~/lib/utils";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import RTable from "~/ui/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Input } from "~/ui/primitives/input";
import { ResponsiveSheet } from "~/ui/primitives/responsive-sheet";

import {
  fieldSuggestionBasisFromRecord,
  suggestTargetsFor,
} from "./field-suggestion";

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
        cell: ({ row }) =>
          row.original.roster
            ? `${row.original.choiceKind} · roster`
            : row.original.choiceKind,
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
        cell: ({ row }) =>
          row.original.counts ? formatCount(row.original.counts.pending) : "—",
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
        cell: ({ row }) => row.original.model,
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
                to="/ai"
                search={{ tab: "review", entity: row.entity, field: row.field }}
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
  const rows = useMemo(() => catalog.data ?? [], [catalog.data]);
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
  return (
    <Stack gap="sm">
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
        onRowClick={(row) => onSelect(row.original.key)}
        currentRowId={selected}
        emptyState="No decisions are declared."
      />
      <ResponsiveSheet
        open={current !== undefined}
        onOpenChange={(open) => {
          if (!open) onSelect(undefined);
        }}
        title={current?.label ?? "Decision"}
        description={current?.key}
      >
        {current ? <DecisionDetail row={current} /> : null}
      </ResponsiveSheet>
    </Stack>
  );
}
