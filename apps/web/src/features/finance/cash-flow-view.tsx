import type {
  CashFlowProjectionOut,
  CashFlowScenario,
} from "@cubby/schemas/cash-flow";
import {
  CASH_FLOW_MAX_SCENARIOS,
  cashFlowScenarioSchema,
} from "@cubby/schemas/cash-flow";
import { ChartBarIcon } from "@phosphor-icons/react/dist/csr/ChartBar";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import {
  CashFlowChart,
  type CashFlowSegmentTarget,
  cashFlowSegments,
} from "~/features/finance/cash-flow-chart";
import {
  type CashFlowSearch,
  cashFlowInputFromSearch,
} from "~/features/finance/cash-flow-search";
import { monthLabel } from "~/features/project/project-formatting";
import { cashFlow } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/number-format";
import { Picker } from "~/ui/combobox/picker";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Row, Section, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { StatGrid, StatTile } from "~/ui/primitives/stat-tile";
import { Switch } from "~/ui/primitives/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <Picker
      mode="segmented"
      label={label}
      options={options}
      value={value}
      onValueChange={(next) => {
        const choice = options.find((option) => option.value === next);
        if (choice) onChange(choice.value);
      }}
    />
  );
}

const money = (value: number) => formatCurrency(value, 0);
const numeric = "text-right tabular-nums";

function chartSummary(data: CashFlowProjectionOut): string {
  const first = data.months[0];
  const last = data.months.at(-1);
  if (!first || !last) return "No months projected.";
  const peak = data.months.reduce((max, month) =>
    month.outflow > max.outflow ? month : max,
  );
  return `Projected outflow ${money(data.totals.horizonOutflow)} from ${monthLabel(first.month)} to ${monthLabel(last.month)}, with a flat baseline of ${money(data.totals.baselineMonthly)} a month. Highest month ${monthLabel(peak.month)} at ${money(peak.outflow)}. Net after scenarios ${money(data.totals.netAfterScenarios)}.`;
}

type ScenarioDraft = Omit<CashFlowScenario, "amount" | "until"> & {
  amount: string;
  until: string;
};
const emptyDraft: ScenarioDraft = {
  label: "",
  date: "",
  amount: "",
  direction: "outflow",
  recurrence: "once",
  until: "",
};

function ScenarioEditor({
  scenarios,
  onChange,
}: {
  scenarios: readonly CashFlowScenario[];
  onChange: (next: CashFlowScenario[]) => void;
}) {
  const [draft, setDraft] = useState(emptyDraft);
  const fieldId = useId();
  const parsed = cashFlowScenarioSchema.safeParse({
    label: draft.label,
    date: draft.date,
    amount: Number(draft.amount),
    direction: draft.direction,
    recurrence: draft.recurrence,
    ...(draft.recurrence === "monthly" && draft.until
      ? { until: draft.until }
      : {}),
  });
  const full = scenarios.length >= CASH_FLOW_MAX_SCENARIOS;
  const touched =
    draft.label !== "" || draft.date !== "" || draft.amount !== "";
  return (
    <Stack gap="sm">
      {scenarios.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Scenario</TableHead>
              <TableHead>Starts</TableHead>
              <TableHead>Repeats</TableHead>
              <TableHead className={numeric}>Amount</TableHead>
              <TableHead className="w-8">
                <span className="sr-only">Remove</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scenarios.map((scenario, index) => (
              <TableRow key={JSON.stringify(scenario)}>
                <TableCell>{scenario.label}</TableCell>
                <TableCell className="tabular-nums">{scenario.date}</TableCell>
                <TableCell>
                  {scenario.recurrence === "once"
                    ? "Once"
                    : scenario.until
                      ? `Monthly until ${scenario.until}`
                      : "Monthly"}
                </TableCell>
                <TableCell
                  className={
                    scenario.direction === "inflow"
                      ? `${numeric} text-positive`
                      : numeric
                  }
                >
                  {scenario.direction === "inflow" ? "+" : "−"}
                  {formatCurrency(scenario.amount)}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${scenario.label}`}
                    onClick={() =>
                      onChange(scenarios.filter((_, at) => at !== index))
                    }
                  >
                    <XIcon />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="my-0 text-xs text-muted-foreground">
          No scenarios. Add a planned inflow or outflow to see its effect on
          net; scenarios live in this page&apos;s link only.
        </p>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!parsed.success || full) return;
          onChange([...scenarios, parsed.data]);
          setDraft(emptyDraft);
        }}
      >
        <label
          htmlFor={`${fieldId}-label`}
          className="flex flex-col gap-1 text-xs"
        >
          Label
          <Input
            id={`${fieldId}-label`}
            className="w-44"
            value={draft.label}
            maxLength={80}
            onChange={(event) =>
              setDraft({ ...draft, label: event.target.value })
            }
          />
        </label>
        <label
          htmlFor={`${fieldId}-date`}
          className="flex flex-col gap-1 text-xs"
        >
          Date
          <Input
            id={`${fieldId}-date`}
            type="date"
            className="w-36"
            value={draft.date}
            onChange={(event) =>
              setDraft({ ...draft, date: event.target.value })
            }
          />
        </label>
        <label
          htmlFor={`${fieldId}-amount`}
          className="flex flex-col gap-1 text-xs"
        >
          Amount
          <Input
            id={`${fieldId}-amount`}
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            className="w-28 tabular-nums"
            value={draft.amount}
            onChange={(event) =>
              setDraft({ ...draft, amount: event.target.value })
            }
          />
        </label>
        <Choice
          label="Direction"
          value={draft.direction}
          options={[
            { value: "outflow", label: "Outflow" },
            { value: "inflow", label: "Inflow" },
          ]}
          onChange={(direction) => setDraft({ ...draft, direction })}
        />
        <Choice
          label="Recurrence"
          value={draft.recurrence}
          options={[
            { value: "once", label: "Once" },
            { value: "monthly", label: "Monthly" },
          ]}
          onChange={(recurrence) => setDraft({ ...draft, recurrence })}
        />
        {draft.recurrence === "monthly" ? (
          <label
            htmlFor={`${fieldId}-until`}
            className="flex flex-col gap-1 text-xs"
          >
            Until (optional)
            <Input
              id={`${fieldId}-until`}
              type="date"
              className="w-36"
              value={draft.until}
              onChange={(event) =>
                setDraft({ ...draft, until: event.target.value })
              }
            />
          </label>
        ) : null}
        <Button type="submit" size="sm" disabled={!parsed.success || full}>
          Add scenario
        </Button>
        {touched && !parsed.success ? (
          <p className="my-0 basis-full text-xs text-destructive">
            {parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}
          </p>
        ) : null}
        {full ? (
          <p className="my-0 basis-full text-xs text-muted-foreground">
            At most {CASH_FLOW_MAX_SCENARIOS} scenarios.
          </p>
        ) : null}
      </form>
    </Stack>
  );
}

function Legend({ data }: { data: CashFlowProjectionOut }) {
  const seen = new Set<string>();
  const items = cashFlowSegments(data).filter((segment) => {
    // Envelopes share one hue; list them once.
    const name = segment.key.startsWith("envelope:")
      ? "Project envelopes"
      : segment.label;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground">
      {items.map((segment) => (
        <li key={segment.key} className="flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-xs"
            style={{ backgroundColor: segment.color }}
            aria-hidden="true"
          />
          {segment.key.startsWith("envelope:")
            ? "Project envelopes"
            : segment.label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className="h-0.5 w-3 bg-foreground" aria-hidden="true" />
        Net
      </li>
    </ul>
  );
}

/**
 * Forward monthly cash flow (household-finance-synthesis §7). Every figure is
 * computed by `cashFlow.projection`; this view only arranges it.
 */
export function CashFlowView({
  search,
  onSearchChange,
}: {
  search: CashFlowSearch;
  onSearchChange: (next: Partial<CashFlowSearch>) => void;
}) {
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const notStartedId = useId();
  const input = cashFlowInputFromSearch(search);
  const query = useQuery(cashFlow.projection.queryOptions(input));
  const data = hydrated ? query.data : undefined;
  const state = visualizationState({
    data,
    isLoading: !hydrated || query.isLoading,
    error: hydrated ? query.error : null,
    empty:
      data?.months.every(
        (month) => month.outflow === 0 && month.scenarioInflow === 0,
      ) ?? false,
    onRetry: () => void query.refetch(),
  });

  const open = (target: CashFlowSegmentTarget) =>
    target.kind === "project"
      ? void navigate({
          to: "/projects/$shortcode",
          params: { shortcode: target.id },
        })
      : void navigate({
          to: "/expenses",
          search: { ...target.filter, view: "table" },
        });

  return (
    <Stack gap="lg">
      <Row align="center" gap="md" className="flex-wrap">
        <Choice
          label="Horizon"
          value={String(input.horizonMonths ?? 12)}
          options={[
            { value: "6", label: "6 months" },
            { value: "12", label: "12 months" },
            { value: "24", label: "24 months" },
          ]}
          onChange={(value) =>
            onSearchChange({
              horizon: value === "12" ? undefined : value === "6" ? 6 : 24,
            })
          }
        />
        <Choice
          label="Irregular categories"
          value={input.irregular ?? "grouped"}
          options={[
            { value: "grouped", label: "Group irregular" },
            { value: "separate", label: "Separate irregular" },
          ]}
          onChange={(value) =>
            onSearchChange({
              irregular: value === "grouped" ? undefined : value,
            })
          }
        />
        <label
          htmlFor={notStartedId}
          className="flex items-center gap-2 text-xs"
        >
          <Switch
            id={notStartedId}
            checked={input.includeNotStarted ?? false}
            onCheckedChange={(checked: boolean) =>
              onSearchChange({ notStarted: checked ? true : undefined })
            }
          />
          Include not-started projects
        </label>
      </Row>

      {data ? (
        <StatGrid>
          <StatTile label={`Outflow, next ${data.months.length} months`}>
            {money(data.totals.horizonOutflow)}
          </StatTile>
          <StatTile label="Baseline per month">
            {money(data.totals.baselineMonthly)}
          </StatTile>
          <StatTile label="Net after scenarios">
            {money(data.totals.netAfterScenarios)}
          </StatTile>
          <StatTile label="Unscheduled remaining">
            {money(data.totals.unscheduledTotal)}
          </StatTile>
          <StatTile label="Beyond horizon">
            {money(
              data.totals.beyondHorizon + data.totals.committedBeyondHorizon,
            )}
          </StatTile>
        </StatGrid>
      ) : null}

      <Section
        title="Monthly projection"
        meta={
          data
            ? `Baseline from ${data.baselineWindow.from} to ${data.baselineWindow.to}`
            : null
        }
      >
        <Visualization
          state={state}
          icon={ChartBarIcon}
          message="Nothing to project."
          subMessage="No landed spend in the last 12 months, no project envelopes, no committed Expenses, and no scenarios."
          height={340}
        >
          {data ? (
            <figure aria-label={chartSummary(data)} className="m-0 space-y-2">
              <figcaption className="sr-only">{chartSummary(data)}</figcaption>
              <CashFlowChart data={data} onOpen={open} />
              <Legend data={data} />
            </figure>
          ) : null}
        </Visualization>
      </Section>

      <Section title="Scenarios">
        <ScenarioEditor
          scenarios={search.scenarios ?? []}
          onChange={(next) =>
            onSearchChange({ scenarios: next.length > 0 ? next : undefined })
          }
        />
      </Section>

      {data && data.baseline.length > 0 ? (
        <Section title="Baseline by Spending Category">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead className={numeric}>Months with spend</TableHead>
                <TableHead className={numeric}>Trailing 12 months</TableHead>
                <TableHead className={numeric}>Per month</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.baseline.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    {row.ledgerFilter ? (
                      <Link
                        to="/expenses"
                        search={{ ...row.ledgerFilter, view: "table" }}
                        className="underline-offset-4 hover:underline"
                      >
                        {row.label}
                      </Link>
                    ) : (
                      row.label
                    )}
                    {row.irregular ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {row.key === "irregular"
                          ? "Categories with spend in fewer than 3 months, at their mean"
                          : "Irregular, at its mean"}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className={numeric}>
                    {row.activeMonths} of 12
                  </TableCell>
                  <TableCell className={numeric}>
                    {formatCurrency(row.trailingTotal)}
                  </TableCell>
                  <TableCell className={numeric}>
                    {formatCurrency(row.monthly)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      ) : null}

      {data ? (
        <ProjectTable
          title="Scheduled envelopes"
          empty="No counted project has an estimate and a future end date."
          rows={data.envelopes.map((row) => ({
            ...row,
            note:
              row.beyondHorizon > 0
                ? `${formatCurrency(row.beyondHorizon)} beyond horizon`
                : null,
          }))}
        />
      ) : null}
      {data ? (
        <ProjectTable
          title="Unscheduled"
          empty="Every counted project with an estimate has a future end date."
          rows={data.unscheduled.map((row) => ({ ...row, note: null }))}
        />
      ) : null}
    </Stack>
  );
}

function ProjectTable({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: ReadonlyArray<{
    id: string;
    name: string;
    estimate: number;
    actual: number;
    committed: number;
    remaining: number;
    endDate: string | null;
    note: string | null;
  }>;
}) {
  return (
    <Section title={title}>
      {rows.length === 0 ? (
        <p className="my-0 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Ends</TableHead>
              <TableHead className={numeric}>Estimate</TableHead>
              <TableHead className={numeric}>Actual</TableHead>
              <TableHead className={numeric}>Committed</TableHead>
              <TableHead className={numeric}>Remaining</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link
                    to="/projects/$shortcode"
                    params={{ shortcode: row.id }}
                    className="underline-offset-4 hover:underline"
                  >
                    {row.name}
                  </Link>
                  {row.note ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {row.note}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="tabular-nums">
                  {row.endDate ?? "No end date"}
                </TableCell>
                <TableCell className={numeric}>
                  {formatCurrency(row.estimate)}
                </TableCell>
                <TableCell className={numeric}>
                  {formatCurrency(row.actual)}
                </TableCell>
                <TableCell className={numeric}>
                  {formatCurrency(row.committed)}
                </TableCell>
                <TableCell className={`${numeric} font-medium`}>
                  {formatCurrency(row.remaining)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
