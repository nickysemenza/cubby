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
import { prepareExpenseDerivedRead } from "~/server/domains/expense/repo/expense-derived-read";
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
 * the earlier key, so a path never gains or loses a cent of its share.
 */
const splitCents = (cents: bigint, funders: readonly Funder[]) => {
  const total = funders.reduce((sum, funder) => sum + funder.weight, 0n);
  const sign = cents < 0n ? -1n : 1n;
  const amount = cents * sign;
  const parts = funders.map((funder, index) => ({
    index,
    base: (amount * funder.weight) / total,
    remainder: (amount * funder.weight) % total,
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
  const shareProject = alias(project, "flowShareProject");
  const { roots, root } = rootSpendingCategoryJoins;
  const shares = await unwrapDb(db)
    .select({
      expenseId: expense.id,
      projectKey: shareProject.shortcode,
      projectLabel: shareProject.name,
      categoryKey: rootSpendingCategoryKeySql,
      categoryLabel: rootSpendingCategoryLabelSql,
      cents: sql<string>`sum(allocation."attributedCents"::bigint)::text`,
    })
    .from(expense)
    .innerJoin(read.allocations, sql`allocation."expenseId" = ${expense.id}`)
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
    );

  const expenseIds = [...new Set(shares.map((share) => share.expenseId))];
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
  for (const share of shares) {
    const cents = BigInt(share.cents);
    const projectNode = node(
      "project",
      projectBucket(share.projectKey, share.projectLabel),
    );
    const categoryNode = node(
      "category",
      categoryBucket(share.categoryKey, share.categoryLabel),
    );
    const funders = (fundersByExpense.get(share.expenseId) ?? []).filter(
      (funder) => funder.weight > 0n,
    );
    const split = funders.length > 0 ? funders : [unknownFunder];
    splitCents(cents, split).forEach((part, index) => {
      const funderOf = split[index]!;
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
      // A funder node narrows nothing the Ledger can express; a grouped
      // bucket has no single filter, so its links open nothing.
      const filter =
        to?.filter == null ||
        (from?.column !== "funder" && from?.filter == null)
          ? null
          : { ...from?.filter, ...to.filter };
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
