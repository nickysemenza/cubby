import type { ReportBlock } from "@cubby/schemas/entity-report";
import { COST_TYPE_LABELS } from "@cubby/schemas/expense-fields";
import { projectContributionInput } from "@cubby/schemas/household-contribution";
import { contributionGapLabels } from "@cubby/schemas/household-contribution-labels";
import {
  type ProjectShortcode,
  projectShortcode,
} from "@cubby/schemas/identifiers";
import { LEDGER_PARTY_KIND_LABELS } from "@cubby/schemas/ledger-party-fields";
import { expenseFiltersSchema } from "@cubby/schemas/project";
import { sum } from "es-toolkit";

import { countLabel } from "~/lib/pluralize";
import { buildDetailScheduleRows } from "~/lib/project-schedule";
import { budgetRemaining } from "~/lib/spend";
import { formatCurrency } from "~/lib/utils";
import type { Database } from "~/server/db";
import {
  expenseAnalytics,
  expenseSpendSummary,
} from "~/server/repo/expense/analytics";
import { projectContribution } from "~/server/repo/household-contribution/reports";
import { listAll } from "~/server/repo/list-all";
import { getProjectByID } from "~/server/repo/project/crud";
import { projectList } from "~/server/repo/project/lookup";
import {
  collectDescendantIds,
  loadProjectTree,
} from "~/server/repo/project/subtree";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { taskList } from "~/server/repo/task/lookup";

/** The validated public code of a live project (a mismatched prefix is refused). */
async function liveProject(db: Database, code: string) {
  const projectCode = projectShortcode.parse(code);
  return {
    code: projectCode,
    id: await resolveOrThrow(db, "project", projectCode),
  };
}

/** `n expense(s) have no recorded cost`: unknown spend is counted, never read as $0. */
const unpricedNote = (count: number): ReportBlock => ({
  kind: "note",
  text: `${countLabel(count, "expense")} ${count === 1 ? "has" : "have"} no recorded cost and ${count === 1 ? "is" : "are"} not in these figures.`,
});

/** The project plus every live sub-project, the scope all spend figures share. */
const subtreeSpend = (projectId: ProjectShortcode) =>
  expenseFiltersSchema.parse({ projectId, includeSubProjects: true });

/** Estimate against actual, committed and credited spend over the subtree. */
export async function projectBudgetReport(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const { code: projectCode, id } = await liveProject(db, code);
  const [tree, spend] = await Promise.all([
    loadProjectTree(db),
    expenseSpendSummary(db, subtreeSpend(projectCode)),
  ]);
  // The subtree estimate is the sum of the non-null estimates; none stays unknown, not $0.
  const estimates = [id, ...collectDescendantIds(tree.childrenByParent, id)]
    .map((projectId) => tree.rowsById.get(projectId)?.costEstimate)
    .filter((value): value is number => value != null);
  const estimate = estimates.length > 0 ? sum(estimates) : null;
  const priced = spend.count - spend.unpricedCount;
  if (estimate == null && priced === 0)
    return [
      spend.unpricedCount > 0
        ? unpricedNote(spend.unpricedCount)
        : {
            kind: "note",
            text: "No estimate or spend yet — set a cost estimate or log the first expense.",
          },
    ];
  const remaining = budgetRemaining(estimate ?? null, spend);
  const figures: Extract<ReportBlock, { kind: "stats" }>["figures"] = [
    { label: "Estimate", value: estimate ?? null, format: "money" },
    { label: "Actual", value: spend.actual, format: "money", tone: "positive" },
  ];
  const series: Extract<ReportBlock, { kind: "chart" }>["series"] = [
    { label: "Actual", value: spend.actual, tone: "positive" },
  ];
  if (spend.committed > 0) {
    figures.push({
      label: "Committed",
      value: spend.committed,
      format: "money",
      tone: "warning",
    });
    series.push({
      label: "Committed",
      value: spend.committed,
      tone: "warning",
    });
  }
  if (spend.credits > 0)
    figures.push({
      label: "Credits",
      value: -spend.credits,
      format: "money",
      tone: "muted",
    });
  figures.push({
    label: "Remaining",
    value: remaining,
    format: "money",
    tone: remaining != null && remaining < 0 ? "destructive" : undefined,
  });
  const chart: Extract<ReportBlock, { kind: "chart" }> = {
    kind: "chart",
    mark: "stack",
    format: "money",
    series,
    caption: `${formatCurrency(spend.actual, 0)} spent of ${estimate != null ? formatCurrency(estimate, 0) : "no estimate"}${spend.committed > 0 ? `, ${formatCurrency(spend.committed, 0)} committed` : ""}`,
  };
  if (estimate != null && estimate > 0) chart.marker = estimate;
  const blocks: ReportBlock[] = [{ kind: "stats", figures }, chart];
  if (spend.unpricedCount > 0) blocks.push(unpricedNote(spend.unpricedCount));
  return blocks;
}

const TOP = 10;

/** Expense analytics scoped to the project and its sub-project subtree. */
export async function projectAnalyticsReport(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const analytics = await expenseAnalytics(
    db,
    subtreeSpend((await liveProject(db, code)).code),
  );
  const { summary } = analytics;
  if (summary.count === 0)
    return [{ kind: "note", text: "No expenses recorded for this project." }];
  if (summary.count === summary.unpricedCount)
    return [unpricedNote(summary.unpricedCount)];
  const byNet = <Row extends { net: number }>(rows: Row[]) =>
    [...rows].sort((a, b) => b.net - a.net).slice(0, TOP);
  const blocks: ReportBlock[] = [
    {
      kind: "stats",
      figures: [
        { label: "Net", value: summary.net, format: "money" },
        {
          label: "Actual",
          value: summary.actual,
          format: "money",
          tone: "positive",
        },
        {
          label: "Committed",
          value: summary.committed,
          format: "money",
          tone: "warning",
        },
        {
          label: "Credits",
          value: -summary.credits,
          format: "money",
          tone: "muted",
        },
        { label: "Expenses", value: summary.count, format: "count" },
      ],
    },
    {
      kind: "chart",
      title: "Cumulative spend",
      mark: "line",
      format: "money",
      series: analytics.cumulative.map((point) => ({
        label: point.month,
        value: point.cumulativeNet,
      })),
    },
    {
      kind: "chart",
      title: "By month",
      mark: "bar",
      format: "money",
      series: analytics.monthly.map((row) => ({
        label: row.month,
        value: row.net,
      })),
    },
    {
      kind: "chart",
      title: "By cost type",
      mark: "bar",
      format: "money",
      series: byNet(analytics.byCostType).map((row) => ({
        label: COST_TYPE_LABELS[row.costType],
        value: row.net,
      })),
    },
    {
      kind: "chart",
      title: "By project",
      mark: "bar",
      format: "money",
      series: byNet(analytics.byProject).map((row) => ({
        label: row.projectName,
        value: row.net,
        ref: { entity: "project" as const, id: row.projectId },
      })),
    },
    {
      kind: "chart",
      title: "By vendor",
      mark: "bar",
      format: "money",
      series: byNet(analytics.byVendor).map((row) => ({
        label: row.vendorName,
        value: row.net,
      })),
    },
  ];
  if (summary.unpricedCount > 0)
    blocks.push(unpricedNote(summary.unpricedCount));
  return blocks;
}

/** Whole-group cost, who consumed and funded it, and the attribution gaps. */
export async function projectContributionReport(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const data = await projectContribution(
    db,
    projectContributionInput.parse({
      projectId: (await liveProject(db, code)).code,
      includeSubprojects: true,
    }),
  );
  const figure = (label: string, value: number) => ({
    label,
    value,
    format: "money" as const,
  });
  // A party row opens the party; its kind is a neutral chip, not a warning badge.
  const partyRow = (
    party: (typeof data.parties)[number]["party"],
    amount: number,
  ) => ({
    entity: "ledgerParty",
    id: party.id,
    title: party.name,
    subtitle: null,
    trailing: formatCurrency(amount),
    statuses: [{ label: LEDGER_PARTY_KIND_LABELS[party.kind] }],
  });
  return [
    {
      kind: "note",
      text: "Spend stays whole-group here. Initial funding is historical; later reimbursements remain in the household ledger rather than changing this project.",
    },
    {
      kind: "stats",
      figures: [
        figure("Whole-group cost", data.wholeGroupCost),
        figure("Actual", data.actualSpend),
        figure("Committed", data.committedSpend),
        // A negative adjustment on every client; `0 -` keeps no credit at 0, not -0.
        figure("Credits", 0 - data.creditsReceived),
        figure("Household initial exposure", data.householdInitialExposure),
        figure("Guest initial funding", data.guestInitialFunding),
        figure("Unattributed consumption", data.unattributedConsumption),
        figure("Unattributed funding", data.unattributedInitialFunding),
      ],
    },
    {
      kind: "records",
      title: "Beneficiaries",
      rows: data.parties.map(({ party, consumed }) =>
        partyRow(party, consumed),
      ),
      empty:
        "No beneficiaries attributed. Record who consumed the project’s spend to compare contributions fairly.",
    },
    {
      kind: "records",
      title: "Original funders",
      rows: data.funders.map(({ party, initiallyFunded }) =>
        partyRow(party, initiallyFunded),
      ),
      empty:
        "No original funders attributed. Initial funding can be recorded without implying a later reimbursement.",
    },
    ...(data.gaps.length > 0
      ? [
          {
            kind: "table" as const,
            title: "Attribution gaps",
            columns: ["Issue", "Amount", "Records"],
            rows: data.gaps.map((gap, index) => ({
              id: `${gap.code}:${index}`,
              cells: [
                contributionGapLabels[gap.code],
                gap.amount === undefined ? "—" : formatCurrency(gap.amount),
                gap.count === undefined
                  ? gap.targetIds.join(", ")
                  : countLabel(gap.count, "expense"),
              ],
            })),
            truncated: data.gapsTruncated,
          },
        ]
      : []),
  ];
}

/** Every live sub-project and task under the project, with dates and dependency ids. */
export async function projectScheduleReport(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const { code: projectCode, id } = await liveProject(db, code);
  const root = await getProjectByID(db, id);
  const [descendants, tasks] = await Promise.all([
    listAll((pagination) =>
      projectList(
        db,
        { parentProjectId: projectCode, includeSubProjects: true },
        [{ orderBy: "name", direction: "asc" }],
        pagination,
      ),
    ),
    listAll((pagination) =>
      taskList(
        db,
        { projectId: projectCode, includeSubProjects: true },
        [{ orderBy: "createdAt", direction: "desc" }],
        pagination,
      ),
    ),
  ]);
  return [
    {
      kind: "schedule",
      rows: buildDetailScheduleRows(root, descendants.data, tasks.data),
    },
  ];
}
