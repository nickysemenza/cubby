import type { Entity } from "./entity";
import {
  relationshipsFor,
  type RelationshipCatalog,
} from "./relationship-paths";
export {
  relationshipsFor,
  relationshipSources,
  type RelationshipCatalog,
} from "./relationship-paths";

/** Typed hooks for derived terminal relationships; physical routes need no hook. */
const derivedConnectedRelationships = [
  {
    source: "purchase",
    key: "emails",
    target: "email",
    resolver: "purchaseEmails",
  },
] as const;
export type DerivedConnectedRelationship =
  (typeof derivedConnectedRelationships)[number];
export const derivedConnectedRelationship = (source: string, key: string) =>
  derivedConnectedRelationships.find(
    (relationship) =>
      relationship.source === source && relationship.key === key,
  );

export interface ConnectedView {
  key: string;
  title: string;
  target: Entity;
  /** Related documents supplement citations; they do not verify field values. */
  evidence?: boolean;
  /** Each route follows named, directional manifest relationships. */
  routes: readonly (readonly string[])[];
}

/**
 * Only curated indirect routes need an entry; every entity's direct relations
 * compile automatically. Paths through a shared vendor, purchase,
 * or project into unrelated sibling records are intentionally absent.
 */
export const curatedConnectionViews = {
  product: [
    {
      key: "settlement-transactions",
      title: "Settlement transactions",
      target: "financialTransaction",
      routes: [["purchases", "financial-transactions"]],
    },
    {
      key: "purchase-projects",
      title: "Purchase projects",
      target: "project",
      routes: [["expenses", "project"]],
    },
    {
      key: "source-emails",
      title: "Related Emails",
      target: "email",
      evidence: true,
      routes: [["purchases", "emails"]],
    },
    {
      key: "source-documents",
      title: "Purchase documents",
      target: "image",
      evidence: true,
      routes: [["purchases", "images"]],
    },
    {
      key: "recipes",
      title: "Recipes",
      target: "recipe",
      routes: [["ingredient", "recipes"]],
    },
  ],
  recipe: [
    {
      key: "products",
      title: "Ingredient products",
      target: "product",
      routes: [["ingredients", "products"]],
    },
    {
      key: "inventory",
      title: "Ingredient stock",
      target: "inventory",
      routes: [["ingredients", "products", "inventory"]],
    },
    {
      key: "purchases",
      title: "Ingredient purchases",
      target: "purchase",
      routes: [["ingredients", "products", "purchases"]],
    },
  ],
  ingredient: [
    {
      key: "inventory",
      title: "Stock",
      target: "inventory",
      routes: [["products", "inventory"]],
    },
    {
      key: "purchases",
      title: "Purchases",
      target: "purchase",
      routes: [["products", "purchases"]],
    },
    {
      key: "expenses",
      title: "Expense history",
      target: "expense",
      routes: [["products", "expenses"]],
    },
    {
      key: "vendors",
      title: "Vendors",
      target: "vendor",
      routes: [["products", "vendors"]],
    },
    {
      key: "locations",
      title: "Stocked locations",
      target: "location",
      routes: [["products", "locations"]],
    },
  ],
  cookbook: [
    {
      key: "copy-locations",
      title: "Physical copy locations",
      target: "location",
      routes: [["product", "inventory", "location"]],
    },
    {
      key: "ingredients",
      title: "Ingredients",
      target: "ingredient",
      routes: [["recipes", "ingredients"]],
    },
    {
      key: "meals",
      title: "Meals",
      target: "meal",
      routes: [["recipes", "meals"]],
    },
    {
      key: "products",
      title: "Ingredient products",
      target: "product",
      routes: [["recipes", "ingredients", "products"]],
    },
  ],
  location: [
    {
      key: "products",
      title: "Stored products",
      target: "product",
      routes: [["inventory", "product"]],
    },
    {
      key: "purchases",
      title: "Stored product purchases",
      target: "purchase",
      routes: [["inventory", "product", "purchases"]],
    },
    {
      key: "expenses",
      title: "Stored product expenses",
      target: "expense",
      routes: [["inventory", "product", "expenses"]],
    },
    {
      key: "plants",
      title: "Plants",
      target: "plant",
      routes: [["plantings", "plant"]],
    },
    {
      key: "tasks",
      title: "Planting tasks",
      target: "task",
      routes: [["plantings", "task"]],
    },
    {
      key: "projects",
      title: "Planting projects",
      target: "project",
      routes: [["plantings", "task", "project"]],
    },
  ],
  inventory: [
    {
      key: "purchases",
      title: "Purchases",
      target: "purchase",
      routes: [["product", "purchases"]],
    },
    {
      key: "expenses",
      title: "Expense history",
      target: "expense",
      routes: [["product", "expenses"]],
    },
    {
      key: "tasks",
      title: "Product tasks",
      target: "task",
      routes: [["product", "tasks"]],
    },
    {
      key: "projects",
      title: "Purchased for projects",
      target: "project",
      routes: [["product", "purchased-projects"]],
    },
    {
      key: "vendors",
      title: "Vendors",
      target: "vendor",
      routes: [["product", "vendors"]],
    },
    {
      key: "meals",
      title: "Meals",
      target: "meal",
      routes: [["product", "meals"]],
    },
    {
      key: "plant",
      title: "Plant",
      target: "plant",
      routes: [["product", "grows-plant"]],
    },
  ],
  meal: [
    {
      key: "purchases",
      title: "Food purchases",
      target: "purchase",
      routes: [["food-products", "purchases"]],
    },
    {
      key: "ingredients",
      title: "Recipe ingredients",
      target: "ingredient",
      routes: [["recipes", "ingredients"]],
    },
  ],
  ledgerParty: [
    {
      key: "products",
      title: "Owned or used products",
      target: "product",
      routes: [
        ["inventory", "product"],
        ["meals", "food-products"],
        ["expenses", "product"],
      ],
    },
    {
      key: "purchases",
      title: "Expense purchases",
      target: "purchase",
      routes: [["expenses", "purchase"]],
    },
    {
      key: "projects",
      title: "Expense projects",
      target: "project",
      routes: [["expenses", "project"]],
    },
  ],
  ledgerTransfer: [
    {
      key: "purchases",
      title: "Evidence purchases",
      target: "purchase",
      routes: [["evidence-transactions", "purchase"]],
    },
  ],
  project: [
    {
      key: "plantings",
      title: "Task plantings",
      target: "planting",
      routes: [["tasks", "plantings"]],
    },
    {
      key: "plants",
      title: "Task plants",
      target: "plant",
      routes: [["tasks", "plantings", "plant"]],
    },
    {
      key: "garden-entries",
      title: "Task garden entries",
      target: "gardenEntry",
      routes: [["tasks", "plantings", "entries"]],
    },
    {
      key: "transactions",
      title: "Expense transactions",
      target: "financialTransaction",
      routes: [["expenses", "transactions"]],
    },
  ],
  task: [
    {
      key: "purchases",
      title: "Subject purchases",
      target: "purchase",
      routes: [["subject", "purchases"]],
    },
    {
      key: "expenses",
      title: "Subject expenses",
      target: "expense",
      routes: [["subject", "expenses"]],
    },
    {
      key: "inventory",
      title: "Subject stock",
      target: "inventory",
      routes: [["subject", "inventory"]],
    },
    {
      key: "vendors",
      title: "Subject vendors",
      target: "vendor",
      routes: [["subject", "vendors"]],
    },
    {
      key: "plants",
      title: "Plants",
      target: "plant",
      routes: [["plantings", "plant"]],
    },
    {
      key: "garden-entries",
      title: "Garden entries",
      target: "gardenEntry",
      routes: [["plantings", "entries"]],
    },
  ],
  vendor: [
    {
      key: "settlement-transactions",
      title: "Settlement transactions",
      target: "financialTransaction",
      routes: [["purchases", "financial-transactions"]],
    },
    {
      key: "inventory",
      title: "Stock from purchased products",
      target: "inventory",
      routes: [["products", "inventory"]],
    },
    {
      key: "plantings",
      title: "Plantings from purchased products",
      target: "planting",
      routes: [["products", "plantings"]],
    },
  ],
  purchase: [
    {
      key: "source-emails",
      title: "Related Emails",
      target: "email",
      evidence: true,
      routes: [["emails"]],
    },
    {
      key: "source-documents",
      title: "Documents",
      target: "image",
      evidence: true,
      routes: [["images"]],
    },
    {
      key: "inventory",
      title: "Purchased product stock",
      target: "inventory",
      routes: [["products", "inventory"]],
    },
    {
      key: "tasks",
      title: "Purchased product tasks",
      target: "task",
      routes: [["products", "tasks"]],
    },
    {
      key: "plantings",
      title: "Purchased product plantings",
      target: "planting",
      routes: [["products", "plantings"]],
    },
    {
      key: "plants",
      title: "Purchased plants",
      target: "plant",
      routes: [["products", "grows-plant"]],
    },
  ],
  financialAccount: [
    {
      key: "expenses",
      title: "Settlement expenses",
      target: "expense",
      routes: [["transactions", "expenses"]],
    },
    {
      key: "products",
      title: "Settlement products",
      target: "product",
      routes: [["transactions", "products"]],
    },
    {
      key: "projects",
      title: "Settlement projects",
      target: "project",
      routes: [
        ["transactions", "purchase", "projects"],
        ["transactions", "expenses", "project"],
      ],
    },
  ],
  financialTransaction: [
    {
      key: "settlement-vendors",
      title: "Purchase vendors",
      target: "vendor",
      routes: [["purchase", "vendor"]],
    },
    {
      key: "settlement-products",
      title: "Purchase products",
      target: "product",
      routes: [["purchase", "products"]],
    },
    {
      key: "projects",
      title: "Projects",
      target: "project",
      routes: [
        ["purchase", "projects"],
        ["expenses", "project"],
      ],
    },
  ],
  wish: [
    {
      key: "purchases",
      title: "Candidate purchases",
      target: "purchase",
      routes: [["candidates", "purchases"]],
    },
    {
      key: "inventory",
      title: "Candidate stock",
      target: "inventory",
      routes: [["candidates", "inventory"]],
    },
    {
      key: "vendors",
      title: "Candidate vendors",
      target: "vendor",
      routes: [["candidates", "vendors"]],
    },
  ],
  expense: [
    {
      key: "inventory",
      title: "Product stock",
      target: "inventory",
      routes: [["product", "inventory"]],
    },
    {
      key: "plantings",
      title: "Product plantings",
      target: "planting",
      routes: [["product", "plantings"]],
    },
    {
      key: "plant",
      title: "Plant",
      target: "plant",
      routes: [["product", "grows-plant"]],
    },
    {
      key: "vendor",
      title: "Purchase vendor",
      target: "vendor",
      routes: [["purchase", "vendor"]],
    },
  ],
  planting: [
    {
      key: "products",
      title: "Cultivar products",
      target: "product",
      routes: [["plant", "products"]],
    },
    {
      key: "purchases",
      title: "Source purchases",
      target: "purchase",
      routes: [["source-product", "purchases"]],
    },
    {
      key: "expenses",
      title: "Source expenses",
      target: "expense",
      routes: [["source-product", "expenses"]],
    },
    {
      key: "project",
      title: "Task project",
      target: "project",
      routes: [["task", "project"]],
    },
    {
      key: "ingredient",
      title: "Plant ingredient",
      target: "ingredient",
      routes: [["plant", "ingredient"]],
    },
  ],
  gardenEntry: [
    {
      key: "plants",
      title: "Plants",
      target: "plant",
      routes: [["plantings", "plant"]],
    },
    {
      key: "products",
      title: "Planting products",
      target: "product",
      routes: [["plantings", "source-product"]],
    },
    {
      key: "tasks",
      title: "Planting tasks",
      target: "task",
      routes: [["plantings", "task"]],
    },
    {
      key: "projects",
      title: "Planting projects",
      target: "project",
      routes: [["plantings", "task", "project"]],
    },
    {
      key: "purchases",
      title: "Planting product purchases",
      target: "purchase",
      routes: [["plantings", "source-product", "purchases"]],
    },
  ],
  vendorAccount: [
    {
      key: "products",
      title: "Purchased products",
      target: "product",
      routes: [["purchases", "products"]],
    },
    {
      key: "expenses",
      title: "Expenses",
      target: "expense",
      routes: [["purchases", "expenses"]],
    },
    {
      key: "projects",
      title: "Projects",
      target: "project",
      routes: [["purchases", "projects"]],
    },
  ],
  productCategory: [
    {
      key: "inventory",
      title: "Product stock",
      target: "inventory",
      routes: [["products", "inventory"]],
    },
    {
      key: "purchases",
      title: "Product purchases",
      target: "purchase",
      routes: [["products", "purchases"]],
    },
    {
      key: "expenses",
      title: "Product expenses",
      target: "expense",
      routes: [["products", "expenses"]],
    },
    {
      key: "tasks",
      title: "Product tasks",
      target: "task",
      routes: [["products", "tasks"]],
    },
    {
      key: "projects",
      title: "Purchased projects",
      target: "project",
      routes: [["products", "purchased-projects"]],
    },
    {
      key: "vendors",
      title: "Product vendors",
      target: "vendor",
      routes: [["products", "vendors"]],
    },
  ],
  run: [
    {
      key: "products",
      title: "Imported products",
      target: "product",
      routes: [["purchases", "products"]],
    },
    {
      key: "expenses",
      title: "Imported expenses",
      target: "expense",
      routes: [["purchases", "expenses"]],
    },
    {
      key: "projects",
      title: "Imported projects",
      target: "project",
      routes: [["purchases", "projects"]],
    },
  ],
  plant: [
    {
      key: "growing-locations",
      title: "Growing locations",
      target: "location",
      routes: [["plantings", "location"]],
    },
    {
      key: "purchases",
      title: "Purchases",
      target: "purchase",
      routes: [["products", "purchases"]],
    },
    {
      key: "expenses",
      title: "Expense history",
      target: "expense",
      routes: [["products", "expenses"]],
    },
    {
      key: "inventory",
      title: "Seed and plant stock",
      target: "inventory",
      routes: [["products", "inventory"]],
    },
    {
      key: "locations",
      title: "Stocked locations",
      target: "location",
      routes: [["products", "locations"]],
    },
    {
      key: "vendors",
      title: "Vendors",
      target: "vendor",
      routes: [["products", "vendors"]],
    },
    {
      key: "tasks",
      title: "Tasks",
      target: "task",
      routes: [
        ["products", "tasks"],
        ["plantings", "task"],
      ],
    },
    {
      key: "projects",
      title: "Projects",
      target: "project",
      routes: [
        ["products", "purchased-projects"],
        ["products", "tasks", "project"],
        ["plantings", "task", "project"],
      ],
    },
    {
      key: "garden-entries",
      title: "Garden entries",
      target: "gardenEntry",
      routes: [["plantings", "entries"]],
    },
    {
      key: "recipes",
      title: "Recipes",
      target: "recipe",
      routes: [["ingredient", "recipes"]],
    },
    {
      key: "meals",
      title: "Meals",
      target: "meal",
      routes: [["ingredient", "meals"]],
    },
  ],
} as const satisfies Partial<Record<Entity, readonly ConnectedView[]>>;

export type ConnectionScope = "connections" | "context";
export type ResolvedConnectionView =
  | (ConnectedView & { kind: "paths" })
  | {
      kind: "derived";
      key: string;
      title: string;
      target: Entity;
      filter: string;
    };

interface ConnectionPlan {
  relationships: ReturnType<typeof relationshipsFor>;
  connections: readonly ConnectedView[];
  context: readonly ConnectedView[];
  named: Map<string, ConnectedView>;
}

/** One compiled catalog owns directional relationships, grouped views and named route resolution. */
export function createConnectionCatalog(catalog: RelationshipCatalog) {
  const curated = new Map<string, readonly ConnectedView[]>(
    Object.entries(curatedConnectionViews),
  );
  const plans = new Map<string, ConnectionPlan>(
    catalog.map((entry) => {
      const relationships = relationshipsFor(catalog, entry.key);
      const grouped = new Map<Entity, ConnectedView>();
      const add = (
        target: Entity,
        routes: ConnectedView["routes"],
        evidence = false,
      ) => {
        const previous = grouped.get(target);
        const combined = [...(previous?.routes ?? []), ...routes];
        grouped.set(target, {
          key: `entity:${target}`,
          title:
            catalog.find((candidate) => candidate.key === target)?.plural ??
            target,
          target,
          evidence: previous?.evidence || evidence,
          routes: [
            ...new Map(
              combined.map((route) => [JSON.stringify(route), route]),
            ).values(),
          ],
        });
      };
      for (const relationship of relationships) {
        if (
          relationship.sources.some(
            (source) => source.provenance.kind === "local-path",
          )
        )
          add(relationship.target, [[relationship.key]]);
      }
      const context = curated.get(entry.key) ?? [];
      for (const view of context)
        add(view.target, view.routes, view.evidence ?? false);
      const connections = [...grouped.values()];
      return [
        entry.key,
        {
          relationships,
          connections,
          context,
          named: new Map(
            [...connections, ...context].map((view) => [view.key, view]),
          ),
        },
      ] as const;
    }),
  );
  const plan = (source: string) => {
    const result = plans.get(source);
    if (!result) throw new Error(`No connection catalog entry for ${source}`);
    return result;
  };
  return {
    relationships: (source: string) => plan(source).relationships,
    views: (
      source: string,
      scope: ConnectionScope = "connections",
    ): readonly ConnectedView[] => plan(source)[scope],
    resolve: (
      source: string,
      key: string,
    ): ResolvedConnectionView | undefined => {
      const view = plan(source).named.get(key);
      if (view) return { ...view, kind: "paths" };
      if (!key.startsWith("relation:")) return undefined;
      const relationship = plan(source).relationships.find(
        (item) => item.key === key.slice(9),
      );
      if (!relationship) return undefined;
      const provenance = relationship.sources[0]?.provenance;
      if (provenance?.kind === "derived")
        return {
          kind: "derived",
          key,
          title: relationship.label,
          target: relationship.target,
          filter: provenance.filter,
        };
      if (
        !relationship.sources.some(
          (item) => item.provenance.kind === "local-path",
        )
      )
        return undefined;
      return {
        kind: "paths",
        key,
        title: relationship.label,
        target: relationship.target,
        routes: [[relationship.key]],
      };
    },
  };
}
export type ConnectionCatalog = ReturnType<typeof createConnectionCatalog>;
