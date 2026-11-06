import type { DecisionCatalogRow } from "@cubby/schemas/ai";
import { entityRoster } from "@cubby/schemas/entity-roster";
import type { ListGroupSummary } from "@cubby/schemas/pagination";
import { humanize } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { EntityIcon } from "~/entity/entities";
import RTable from "~/entity/table/table";
import { ai } from "~/integrations/tanstack-query/generated/domains/ai.gen";
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
import { Stack } from "~/ui/layout";
import { SidePanel, SidePanelLayout } from "~/ui/overlays/side-panel";
import { Input } from "~/ui/primitives/input";
import { Facts } from "~/ui/records/facts";
import { Badge } from "~/ui/reui/badge";
import { Description } from "~/ui/text/description";
import { NoneValue } from "~/ui/text/none-value";


const helper = createCubbyColumnHelper<DecisionCatalogRow>();
const decisionScope = (row: DecisionCatalogRow) =>
  row.entity ? entityRoster[row.entity].singular : "Feature";

const ENTITY_CHOICE: GroupConfig["choice"] = {
  key: "entity",
  multiple: false,
  dateKind: null,
  buckets: [],
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
          <Facts
            layout="list"
            className="text-xs"
            facts={row.options.map((option) => ({
              id: option.value,
              label: option.label,
              value: option.description ?? option.value,
            }))}
          />
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
      else
        groups.push({
          key: JSON.stringify([row.entity ?? "feature"]),
          path: [row.entity ?? "feature"],
          label,
          count: 1,
          parentCount: rows.length,
          fraction: null,
          overlapping: false,
        });
    }
    return {
      choice: ENTITY_CHOICE,
      groups,
      memberships: rows.map((row) => ({
        id: row.key,
        path: [row.entity ?? "feature"],
      })),
      header: (group) => {
        const entity = rows.find(
          (row) => (row.entity ?? "feature") === group.path[0],
        )?.entity;
        return entity
          ? {
              aside: (
                <EntityIcon
                  entity={entity}
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
  const step = (direction: -1 | 1) => {
    const index = rows.findIndex((row) => row.key === selected);
    const next = rows[index + direction];
    if (index >= 0 && next) onSelect(next.key);
  };
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
        reads and how its suggestions were reviewed.
      </Description>
      <SidePanelLayout
        title={current?.label ?? "Decision"}
        onClose={() => onSelect(undefined)}
        panel={
          current ? (
            <SidePanel
              label="Decision detail"
              eyebrow="AI decision"
              title={current.label}
              code={current.key}
              onClose={() => onSelect(undefined)}
              onPrev={() => step(-1)}
              onNext={() => step(1)}
            >
              <div className="p-3">
                <DecisionDetail row={current} />
              </div>
            </SidePanel>
          ) : null
        }
      >
        <RTable
          table={table}
          ariaLabel="Decisions"
          withoutImages="Rows are decision families, not records."
          isLoading={catalog.isLoading}
          error={catalog.error}
          toolbarMode="none"
          groupConfig={groupConfig}
          onRowClick={(row) => onSelect(row.original.key)}
          currentRowId={selected}
          emptyState={
            query
              ? "No decision matches that search."
              : "No decisions are declared."
          }
        />
      </SidePanelLayout>
    </Stack>
  );
}
