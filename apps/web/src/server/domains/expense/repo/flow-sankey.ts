import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import {
  type ExpenseFilters,
  type ExpenseFlowSankeyLink,
  type ExpenseFlowSankeyNode,
  type ExpenseFlowSankeyOut,
  HOUSEHOLD_PROJECT_SHORTCODE,
} from "@cubby/schemas/project";
import { and, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { expense, ledgerParty, project } from "~/server/db/schema";
import {
  expenseDerivedReadSql,
  prepareExpenseDerivedRead,
} from "~/server/domains/expense/repo/expense-derived-read";
import { expenseAllocationScopeConditionSql } from "~/server/domains/expense/repo/expense-project-allocation";
import { loadExpenseAllocations } from "~/server/domains/household-contribution/repo/allocation";

import {
  rootSpendingCategoryBucketFilter,
  rootSpendingCategoryJoins,
  rootSpendingCategoryKeySql,
  rootSpendingCategoryLabelSql,
  UNCATEGORIZED_BUCKET,
  UNCLASSIFIED_BUCKET,
} from "./spending-category-root";

const RANKED_BUCKETS = 8;
const OTHER = "other";
const NONE = "none";
const UNKNOWN = "unknown";

type Bucket = {
  id: string;
  label: string;
  filter: Record<string, string> | null;
};
type Funder = { key: string; label: string; weight: bigint };

/**
 * Split `cents` across weights in whole cents by largest remainder, ties to
 * the earlier weight, so a path never gains or loses a cent of its share.
 */
const splitCents = (cents: bigint, weights: readonly bigint[]) => {
  const total = weights.reduce((sum, weight) => sum + weight, 0n);
  const sign = cents < 0n ? -1n : 1n;
  const amount = cents * sign;
  const parts = weights.map((weight, index) => ({
    index,
    base: (amount * weight) / total,
    remainder: (amount * weight) % total,
  }));
  let leftover = amount - parts.reduce((sum, part) => sum + part.base, 0n);
  for (const part of [...parts].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  )) {
    if (leftover === 0n) break;
    part.base += 1n;
    leftover -= 1n;
  }
  return parts.map((part) => part.base * sign);
};

/**
 * Split one Expense's complete set of shares across its funders so each share
 * keeps its cents AND each funder keeps its contribution-ledger cents. Each
 * share draws from what the funders have left, so rounding a share never
 * moves a cent between funders; scope filters apply only afterwards.
 */
const apportionFunders = (
  shares: readonly bigint[],
  weights: readonly bigint[],
): bigint[][] => {
  const total = shares.reduce((sum, cents) => sum + cents, 0n);
  const sign = total < 0n ? -1n : 1n;
  // The joint allocator gives every share its source Expense's sign; a drawdown
  // over mixed signs would move cents between funders.
  if (shares.some((cents) => cents * sign < 0n))
    throw new Error(
      `Expense allocation shares have mixed signs: ${shares.join(", ")}`,
    );
  const remaining = splitCents(total * sign, weights);
  return shares.map((cents) => {
    if (remaining.every((left) => left === 0n))
      return splitCents(cents, weights);
    const parts = splitCents(cents * sign, remaining);
    parts.forEach((part, index) => {
      remaining[index] = (remaining[index] ?? 0n) - part;
    });
    return parts.map((part) => part * sign);
  });
};

const dollars = (cents: bigint) => Number(cents) / 100;

/** Rank by net flow, then label, keeping `limit`; the rest group as Other. */
const rankedKeys = (
  totals: ReadonlyMap<string, { label: string; cents: bigint }>,
  limit: number,
) =>
  new Set(
    [...totals.entries()]
      .sort(([, a], [, b]) =>
        a.cents === b.cents
          ? a.label.localeCompare(b.label)
          : a.cents > b.cents
            ? -1
            : 1,
      )
      .slice(0, limit)
      .map(([key]) => key),
  );

const addTotal = (
  totals: Map<string, { label: string; cents: bigint }>,
  key: string,
  label: string,
  cents: bigint,
) => {
  const current = totals.get(key);
  totals.set(key, { label, cents: (current?.cents ?? 0n) + cents });
};

/**
 * Funder → project bucket → root Spending Category, net per full path over
 * the Ledger's allocation shares. Each share splits across its Expense's
 * funders by the contribution ledger's funder cents, so a multi-funder
 * Expense follows the same weights as household positions.
 */
export async function expenseFlowSankey(
  db: Database,
  filters: ExpenseFilters,
): Promise<ExpenseFlowSankeyOut> {
  const read = await prepareExpenseDerivedRead(db, filters);
  const condition = read.scope
    ? expenseAllocationScopeConditionSql("allocation", read.scope)
    : undefined;
  // The complete joint allocation of each selected Expense, flagged by scope,
  // so funder cents apportion over every share before the filter drops any.
  const allocations = sql`(SELECT allocation.*, coalesce(${condition ?? sql`true`}, false) AS "inScope"
    FROM (${expenseDerivedReadSql("shares", { expenseIds: read.expenseIds })}) allocation) allocation`;
  const shareProject = alias(project, "flowShareProject");
  const { roots, root } = rootSpendingCategoryJoins;
  const shares = await unwrapDb(db)
    .select({
      expenseId: expense.id,
      projectKey: shareProject.shortcode,
      projectLabel: shareProject.name,
      categoryKey: rootSpendingCategoryKeySql,
      categoryLabel: rootSpendingCategoryLabelSql,
      inScope: sql<boolean>`allocation."inScope"`,
      cents: sql<string>`sum(allocation."attributedCents"::bigint)::text`,
    })
    .from(expense)
    .innerJoin(allocations, sql`allocation."expenseId" = ${expense.id}`)
    .leftJoin(
      shareProject,
      and(
        sql`${shareProject.id} = allocation."projectId"`,
        notDeleted(shareProject),
      ),
    )
    .leftJoin(roots.table, roots.on)
    .leftJoin(root.table, root.on)
    .where(and(read.where, sql`allocation."attributedCents" IS NOT NULL`))
    .groupBy(
      expense.id,
      shareProject.shortcode,
      shareProject.name,
      rootSpendingCategoryKeySql,
      rootSpendingCategoryLabelSql,
      sql`allocation."inScope"`,
    );

  const sharesByExpense = new Map<
    (typeof shares)[number]["expenseId"],
    typeof shares
  >();
  for (const share of shares)
    sharesByExpense.set(share.expenseId, [
      ...(sharesByExpense.get(share.expenseId) ?? []),
      share,
    ]);
  const expenseIds = [...sharesByExpense.keys()];
  const funderRows =
    expenseIds.length === 0
      ? []
      : (
          await loadExpenseAllocations(db, {
            expenseIds,
            includeFuture: true,
          })
        ).filter((row) => row.role === "funder");
  // A `~` key is a null, unowned, or deleted party: the Unknown funder.
  const partyCodes = [
    ...new Set(
      funderRows
        .map((row) => row.allocationKey)
        .filter((key) => !key.startsWith("~")),
    ),
  ];
  const partyNames = new Map(
    partyCodes.length === 0
      ? []
      : (
          await unwrapDb(db)
            .select({
              shortcode: ledgerParty.shortcode,
              name: ledgerParty.name,
            })
            .from(ledgerParty)
            .where(inArray(ledgerParty.shortcode, partyCodes))
        ).map((party) => [party.shortcode, party.name]),
  );
  const fundersByExpense = new Map<string, Funder[]>();
  for (const row of funderRows) {
    const known = !row.allocationKey.startsWith("~");
    const key = known ? row.allocationKey : UNKNOWN;
    const list = fundersByExpense.get(row.expenseId) ?? [];
    const weight = row.cents < 0n ? -row.cents : row.cents;
    const existing = list.find((funder) => funder.key === key);
    if (existing) existing.weight += weight;
    else
      list.push({
        key,
        label: known
          ? (partyNames.get(row.allocationKey) ?? row.allocationKey)
          : "Unknown funder",
        weight,
      });
    fundersByExpense.set(row.expenseId, list);
  }
  const unknownFunder: Funder = {
    key: UNKNOWN,
    label: "Unknown funder",
    weight: 1n,
  };

  const projectTotals = new Map<string, { label: string; cents: bigint }>();
  const categoryTotals = new Map<string, { label: string; cents: bigint }>();
  for (const share of shares) {
    if (!share.inScope) continue;
    const cents = BigInt(share.cents);
    if (share.projectKey && share.projectKey !== HOUSEHOLD_PROJECT_SHORTCODE)
      addTotal(
        projectTotals,
        share.projectKey,
        share.projectLabel ?? share.projectKey,
        cents,
      );
    if (
      share.categoryKey !== UNCATEGORIZED_BUCKET &&
      share.categoryKey !== UNCLASSIFIED_BUCKET
    )
      addTotal(categoryTotals, share.categoryKey, share.categoryLabel, cents);
  }
  const keptProjects = rankedKeys(projectTotals, RANKED_BUCKETS);
  const keptCategories = rankedKeys(categoryTotals, RANKED_BUCKETS);

  const nodes = new Map<string, ExpenseFlowSankeyNode>();
  const node = (
    column: ExpenseFlowSankeyNode["column"],
    bucket: Bucket,
  ): string => {
    const id = `${column}:${bucket.id}`;
    if (!nodes.has(id))
      nodes.set(id, { id, column, label: bucket.label, filter: bucket.filter });
    return id;
  };
  const projectBucket = (key: string | null, label: string | null): Bucket =>
    key === null
      ? {
          id: NONE,
          label: "No project",
          filter: { project: FILTER_NONE },
        }
      : key === HOUSEHOLD_PROJECT_SHORTCODE || keptProjects.has(key)
        ? {
            id: key,
            label: label ?? key,
            filter: { project: key, includeSubProjects: "false" },
          }
        : { id: OTHER, label: "Other projects", filter: null };
  const categoryBucket = (key: string, label: string): Bucket =>
    key === UNCATEGORIZED_BUCKET ||
    key === UNCLASSIFIED_BUCKET ||
    keptCategories.has(key)
      ? { id: key, label, filter: rootSpendingCategoryBucketFilter(key) }
      : { id: OTHER, label: "Other categories", filter: null };

  const paths = new Map<
    string,
    { funder: string; project: string; category: string; cents: bigint }
  >();
  const shareOrder = (share: (typeof shares)[number]) =>
    `${share.projectKey ?? ""}\u0000${share.categoryKey}\u0000${share.inScope ? 1 : 0}`;
  for (const [expenseId, expenseShares] of sharesByExpense) {
    expenseShares.sort((a, b) => shareOrder(a).localeCompare(shareOrder(b)));
    const funders = (fundersByExpense.get(expenseId) ?? []).filter(
      (funder) => funder.weight > 0n,
    );
    const split = funders.length > 0 ? funders : [unknownFunder];
    const parts = apportionFunders(
      expenseShares.map((share) => BigInt(share.cents)),
      split.map((funder) => funder.weight),
    );
    expenseShares.forEach((share, shareIndex) => {
      if (!share.inScope) return;
      const projectNode = node(
        "project",
        projectBucket(share.projectKey, share.projectLabel),
      );
      const categoryNode = node(
        "spendingCategory",
        categoryBucket(share.categoryKey, share.categoryLabel),
      );
      split.forEach((funderOf, funderIndex) => {
        const part = parts[shareIndex]?.[funderIndex] ?? 0n;
        if (part === 0n) return;
        const funder = node("funder", {
          id: funderOf.key,
          label: funderOf.label,
          filter: null,
        });
        const key = `${funder}\u0000${projectNode}\u0000${categoryNode}`;
        const path = paths.get(key) ?? {
          funder,
          project: projectNode,
          category: categoryNode,
          cents: 0n,
        };
        path.cents += part;
        paths.set(key, path);
      });
    });
  }

  const linkCents = new Map<string, bigint>();
  const addLink = (source: string, target: string, cents: bigint) => {
    const key = `${source}\u0000${target}`;
    linkCents.set(key, (linkCents.get(key) ?? 0n) + cents);
  };
  let net = 0n;
  let linked = 0n;
  const nonPositivePaths: ExpenseFlowSankeyOut["nonPositivePaths"] = [];
  for (const path of paths.values()) {
    net += path.cents;
    if (path.cents > 0n) {
      linked += path.cents;
      addLink(path.funder, path.project, path.cents);
      addLink(path.project, path.category, path.cents);
    } else {
      nonPositivePaths.push({
        funder: path.funder,
        project: path.project,
        category: path.category,
        net: dollars(path.cents),
      });
    }
  }
  const links: ExpenseFlowSankeyLink[] = [...linkCents.entries()].map(
    ([key, cents]) => {
      const [source = "", target = ""] = key.split("\u0000");
      const from = nodes.get(source);
      const to = nodes.get(target);
      // The Ledger has no funder filter, so funder links open nothing (plan
      // §6); a grouped bucket has no single filter, so its links open nothing.
      const filter =
        from?.column === "funder" || from?.filter == null || to?.filter == null
          ? null
          : { ...from.filter, ...to.filter };
      return { source, target, value: dollars(cents), filter };
    },
  );
  nonPositivePaths.sort((a, b) => a.net - b.net);
  return {
    nodes: [...nodes.values()],
    links,
    nonPositivePaths,
    totals: {
      net: dollars(net),
      linked: dollars(linked),
      nonPositive: dollars(net - linked),
    },
  };
}
