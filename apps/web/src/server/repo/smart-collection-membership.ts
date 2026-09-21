import type {
  SmartCollectionDefinition,
  SmartCollectionMatch,
  SmartCollectionSummary,
} from "@cubby/schemas/collection";
import { TRADE_LABELS, type Trade } from "@cubby/schemas/project";

interface SmartLocation {
  id: string;
  name: string;
  parentId: string | null;
  productId: string | null;
}

export interface SmartCollectionGraph {
  products: readonly {
    id: string;
    manufacturer: string;
    tags: string[];
    category?: string | null;
  }[];
  locations: readonly SmartLocation[];
  inventory: readonly {
    productId: string;
    locationId: string;
    effectiveOwnerId?: string | null;
  }[];
  expenses: readonly {
    productId: string | null;
    shortcode: string;
    trade: Trade;
  }[];
}

type SmartProduct = SmartCollectionGraph["products"][number];
type SmartRule = SmartCollectionDefinition["rules"][number];
type ExpenseByProduct = ReadonlyMap<
  string,
  SmartCollectionGraph["expenses"][number][]
>;

const ownerEvidence = (
  graph: SmartCollectionGraph,
  productId: string,
  ownerId: string,
): string[] =>
  graph.inventory.some(
    (row) => row.productId === productId && row.effectiveOwnerId === ownerId,
  )
    ? [`Owner: ${ownerId}`]
    : [];

const locationEvidence = (
  productId: string,
  query: string,
  placements: ReadonlyMap<string, string[]>,
  ancestry: ReadonlyMap<string, SmartLocation[]>,
): string[] => {
  const evidence = new Set<string>();
  for (const locationId of placements.get(productId) ?? []) {
    const chain = ancestry.get(locationId) ?? [];
    for (const [index, location] of chain.entries()) {
      if (!location.name.toLowerCase().includes(query.toLowerCase())) continue;
      evidence.add(
        `Location: ${chain
          .slice()
          .reverse()
          .map((item) => item.name)
          .join(
            " / ",
          )} (matches ${index === 0 ? "current location" : "ancestor"} “${location.name}”)`,
      );
    }
  }
  return [...evidence];
};

const expenseTradeEvidence = (
  rows: SmartCollectionGraph["expenses"],
  trade: Trade,
): string[] =>
  rows
    .filter((row) => row.trade === trade)
    .map((row) => `${row.shortcode}: ${TRADE_LABELS[row.trade]}`);

function evidenceForRule(
  rule: SmartRule,
  product: SmartProduct,
  graph: SmartCollectionGraph,
  placements: ReadonlyMap<string, string[]>,
  ancestry: ReadonlyMap<string, SmartLocation[]>,
  expenses: ExpenseByProduct,
): string[] {
  switch (rule.kind) {
    case "effectiveOwnerEquals":
      return ownerEvidence(graph, product.id, rule.value);
    case "categoryEquals":
      return product.category === rule.value ? [`Category: ${rule.value}`] : [];
    case "productTagEquals":
      return product.tags.includes(rule.value) ? [`Tag: ${rule.value}`] : [];
    case "manufacturerEquals":
      return product.manufacturer.trim().toLowerCase() ===
        rule.value.trim().toLowerCase()
        ? [`Manufacturer: ${product.manufacturer}`]
        : [];
    case "locationNameContains":
      return locationEvidence(product.id, rule.value, placements, ancestry);
    case "historicalExpenseTrade":
      return expenseTradeEvidence(expenses.get(product.id) ?? [], rule.value);
  }
}

/** Inputs contain only live rows and actual Expenses; no Purchase-level trade inference. */
export function evaluateSmartCollections(
  graph: SmartCollectionGraph,
  definitions: readonly SmartCollectionDefinition[],
) {
  const locations = new Map(graph.locations.map((item) => [item.id, item]));
  const ancestry = new Map<string, SmartLocation[]>();
  for (const location of graph.locations) {
    const chain: SmartLocation[] = [];
    const seen = new Set<string>();
    let current: SmartLocation | undefined = location;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current = current.parentId ? locations.get(current.parentId) : undefined;
    }
    ancestry.set(location.id, chain);
  }
  const placements = new Map<string, string[]>();
  for (const row of graph.inventory) {
    const location = locations.get(row.locationId);
    // A vessel is not its own contents, even if an explicit self-placement exists.
    if (!location || location.productId === row.productId) continue;
    const ids = placements.get(row.productId) ?? [];
    if (!ids.includes(row.locationId)) ids.push(row.locationId);
    placements.set(row.productId, ids);
  }
  const expenses = new Map<
    string,
    SmartCollectionGraph["expenses"][number][]
  >();
  for (const row of graph.expenses) {
    if (!row.productId) continue;
    const rows = expenses.get(row.productId) ?? [];
    rows.push(row);
    expenses.set(row.productId, rows);
  }
  return definitions.map((definition) => {
    const members = new Map<string, SmartCollectionMatch[]>();
    const summary: SmartCollectionSummary = {
      key: definition.key,
      name: definition.name,
      totalCount: 0,
      sourceCounts: {
        effectiveOwnerEquals: 0,
        categoryEquals: 0,
        productTagEquals: 0,
        manufacturerEquals: 0,
        locationNameContains: 0,
        historicalExpenseTrade: 0,
      },
    };
    for (const product of graph.products) {
      const matches: SmartCollectionMatch[] = [];
      definition.rules.forEach((rule, ruleIndex) => {
        const evidence = evidenceForRule(
          rule,
          product,
          graph,
          placements,
          ancestry,
          expenses,
        );
        if (evidence.length)
          matches.push({
            ruleIndex,
            kind: rule.kind,
            value: rule.value,
            evidence,
          });
      });
      if (
        !matches.length ||
        (definition.match === "all" &&
          matches.length !== definition.rules.length)
      )
        continue;
      members.set(product.id, matches);
      for (const kind of new Set(matches.map((match) => match.kind)))
        summary.sourceCounts[kind] += 1;
    }
    summary.totalCount = members.size;
    return { summary, members };
  });
}
