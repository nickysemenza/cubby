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
  products: readonly { id: string; manufacturer: string; tags: string[] }[];
  locations: readonly SmartLocation[];
  inventory: readonly { productId: string; locationId: string }[];
  expenses: readonly {
    productId: string | null;
    shortcode: string;
    trade: Trade;
  }[];
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
        productTagEquals: 0,
        manufacturerEquals: 0,
        locationNameContains: 0,
        historicalExpenseTrade: 0,
      },
    };
    for (const product of graph.products) {
      const matches: SmartCollectionMatch[] = [];
      definition.rules.forEach((rule, ruleIndex) => {
        const evidence = new Set<string>();
        switch (rule.kind) {
          case "productTagEquals":
            if (product.tags.includes(rule.value))
              evidence.add(`Tag: ${rule.value}`);
            break;
          case "manufacturerEquals":
            if (
              product.manufacturer.trim().toLowerCase() ===
              rule.value.trim().toLowerCase()
            )
              evidence.add(`Manufacturer: ${product.manufacturer}`);
            break;
          case "locationNameContains":
            for (const locationId of placements.get(product.id) ?? []) {
              const chain = ancestry.get(locationId) ?? [];
              for (const [index, location] of chain.entries()) {
                if (
                  location.name.toLowerCase().includes(rule.value.toLowerCase())
                ) {
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
            }
            break;
          case "historicalExpenseTrade":
            for (const row of expenses.get(product.id) ?? []) {
              if (row.trade === rule.value)
                evidence.add(`${row.shortcode}: ${TRADE_LABELS[row.trade]}`);
            }
            break;
        }
        if (evidence.size)
          matches.push({
            ruleIndex,
            kind: rule.kind,
            value: rule.value,
            evidence: [...evidence],
          });
      });
      if (!matches.length) continue;
      members.set(product.id, matches);
      for (const kind of new Set(matches.map((match) => match.kind)))
        summary.sourceCounts[kind] += 1;
    }
    summary.totalCount = members.size;
    return { summary, members };
  });
}
