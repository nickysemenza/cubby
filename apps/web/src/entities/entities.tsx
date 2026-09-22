import type { Entity } from "@cubby/schemas/entity";
import type {
  BrowserRoutedEntity,
  ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { displayGtin } from "@cubby/schemas/external-id";
import {
  Apple,
  ArrowLeftRight,
  Barcode,
  BookOpen,
  Bot,
  CalendarDays,
  Carrot,
  ChefHat,
  CreditCard,
  Hammer,
  Heart,
  Image,
  KeyRound,
  ListChecks,
  type LucideIcon,
  type LucideProps,
  MapPin,
  Package,
  Receipt,
  ReceiptText,
  Sprout,
  Store,
  Tags,
  Users,
} from "lucide-react";

import {
  domainForEntity,
  domainWayfinding,
} from "~/app/_components/navigation/domain-wayfinding";
import { purchaseLabel } from "~/lib/purchase-label";
import { cn, formatCurrency } from "~/lib/utils";

import { entityListFor } from "./entity-list.functions";
import { generatedBrowserRoutes } from "./generated/entity-routes.gen";
import {
  defineMergeableConfig,
  type EntityColor,
  type EntityDefinition,
  type MergeDisplayRow,
} from "./types";

interface IngredientMergeRow extends MergeDisplayRow {
  name: string;
}

interface ProductMergeRow extends IngredientMergeRow {
  gtins: string[];
  sources: string[];
}

interface VendorMergeRow extends MergeDisplayRow {
  name: string;
  purchaseCount: number;
  spend: number;
}

interface PurchaseMergeRow extends MergeDisplayRow {
  date: string;
  displayLabel: string | null;
  expenseCount: number;
  expenseTotal: number;
  orderId: string | null;
  vendorId: string;
  vendorName: string | null;
}

const isString = (value: unknown): value is string => typeof value === "string";

const isIngredientMergeRow = (
  row: MergeDisplayRow,
): row is IngredientMergeRow => "name" in row && typeof row.name === "string";

const isProductMergeRow = (row: MergeDisplayRow): row is ProductMergeRow =>
  isIngredientMergeRow(row) &&
  "gtins" in row &&
  Array.isArray(row.gtins) &&
  row.gtins.every(isString) &&
  "sources" in row &&
  Array.isArray(row.sources) &&
  row.sources.every(isString);

const isVendorMergeRow = (row: MergeDisplayRow): row is VendorMergeRow =>
  "name" in row &&
  typeof row.name === "string" &&
  "purchaseCount" in row &&
  typeof row.purchaseCount === "number" &&
  "spend" in row &&
  typeof row.spend === "number";

const isPurchaseMergeRow = (row: MergeDisplayRow): row is PurchaseMergeRow =>
  "vendorId" in row &&
  typeof row.vendorId === "string" &&
  "orderId" in row &&
  (typeof row.orderId === "string" || row.orderId === null) &&
  "displayLabel" in row &&
  (typeof row.displayLabel === "string" || row.displayLabel === null) &&
  "vendorName" in row &&
  (typeof row.vendorName === "string" || row.vendorName === null) &&
  "date" in row &&
  typeof row.date === "string" &&
  "expenseCount" in row &&
  typeof row.expenseCount === "number" &&
  "expenseTotal" in row &&
  typeof row.expenseTotal === "number";

/**
 * The four inks an entity can wear. `accent` feeds the `--page-accent` /
 * `--row-accent` CSS variables (styles.css) for decorative chrome — the
 * page-hero accent bar, table row-hover/selected bars — while the tailwind
 * trio dresses icon tiles and badges.
 *
 * Porcelain Transit: page and row accents resolve through the five domain
 * lines, while quieter entities use graphite. Status semantics
 * (`--positive`/`--warning`) stay separate from domain identity. Entities that
 * need a distinct state treatment spell it out rather than joining a generic
 * hue ladder.
 */
const INK = {
  primary: {
    accent: "var(--primary)",
    bg: "bg-primary/10",
    text: "text-primary",
    border: "border-l-primary",
  },
  slate: {
    accent: "var(--slate)",
    bg: "bg-slate/20",
    text: "text-slate",
    border: "border-l-slate",
  },
  plum: {
    accent: "var(--plum)",
    bg: "bg-plum/15",
    text: "text-plum",
    border: "border-l-plum",
  },
  positive: {
    accent: "var(--positive)",
    bg: "bg-positive/15",
    text: "text-positive",
    border: "border-l-positive",
  },
} satisfies Record<string, EntityColor>;

/**
 * Stamps every definition with the display names its own key already implies.
 *
 * Both come straight from the entity's manifest literal (`names` in
 * `packages/schemas/src/entity-definitions/*.entity.ts`, surfaced as `entitySummary`),
 * so neither is spelled here and neither can disagree with the key it sits
 * under — `wish: { label: ... }` naming a vendor is no longer expressible.
 *
 * `singular` is the UI label for one record; `plural` is the NAV/SECTION name,
 * read where context is already established, so it drops the qualifier the
 * singular needs. It is declared, NOT pluralized: `inventory` → "Inventory"
 * (not "Inventory Items"), `financialAccount` → "Accounts",
 * `financialTransaction` → "Transactions", `wish` → "Wishlist" (not "Wishes").
 * The other twelve coincide with a naive plural, which is exactly the trap —
 * `pluralize` is already a dependency and gets all four of those wrong.
 *
 * Names and the lucide icon (from `presentation.icons.lucide`) are stamped
 * BEFORE the definition spreads in, so an entity that has a genuine reason to
 * depart can still say so and win.
 */
type EntityDefinitionSeed = Pick<
  EntityDefinition,
  "basePath" | "color" | "routes"
>;

/**
 * The `lucide-react` icons the declarations name in `presentation.icons.lucide`.
 * Keyed by that literal union, so a declaration naming an icon this map does
 * not import fails to compile here — the compiler cannot import lucide, this
 * is where the name is checked. Imports stay explicit so the bundle carries
 * only these glyphs.
 */
type DeclaredLucideIcon =
  (typeof entitySummary)[BrowserRoutedEntity]["icons"]["lucide"];
const LUCIDE_ICONS = {
  Apple,
  ArrowLeftRight,
  Barcode,
  BookOpen,
  Bot,
  CalendarDays,
  Carrot,
  ChefHat,
  CreditCard,
  Hammer,
  Heart,
  Image,
  KeyRound,
  ListChecks,
  MapPin,
  Package,
  Receipt,
  ReceiptText,
  Sprout,
  Store,
  Tags,
  Users,
} satisfies Record<DeclaredLucideIcon, LucideIcon>;
const isBrowserEntityKey = (value: string): value is BrowserRoutedEntity =>
  Object.hasOwn(entitySummary, value);

const withEntityNames = <
  const Definitions extends Record<BrowserRoutedEntity, EntityDefinitionSeed>,
>(
  definitions: Definitions,
): {
  [Entity in keyof Definitions & BrowserRoutedEntity]: {
    label: (typeof entitySummary)[Entity]["singular"];
    pluralLabel: (typeof entitySummary)[Entity]["plural"];
    lucideIcon: LucideIcon;
  } & Definitions[Entity];
} =>
  // SAFETY: the runtime key guard preserves every entity key, while
  // Object.fromEntries cannot retain that mapped key/value correlation.
  Object.fromEntries(
    Object.entries(definitions).map(([entity, definition]) => {
      if (!isBrowserEntityKey(entity))
        throw new Error(`Unknown entity ${entity}`);
      return [
        entity,
        {
          label: entitySummary[entity].singular,
          pluralLabel: entitySummary[entity].plural,
          lucideIcon: LUCIDE_ICONS[entitySummary[entity].icons.lucide],
          ...definition,
        },
      ];
    }),
    // `Object.entries` widens the key to `string` and loses the pairing the
    // signature above states; the mapped type is the real contract.
  ) as never;

const entityDefinitions = withEntityNames({
  ingredient: {
    ...generatedBrowserRoutes.ingredient,
    color: {
      accent: INK.slate.accent,
      bg: "bg-warning/20",
      text: "text-accent-foreground",
      border: "border-l-warning",
    },
    // Note: ingredient uses UnitMappingsTable (different from UnitMappingDisplay),
    // so unit-mappings is handled as a custom section
    // Ingredient supplies its domain columns explicitly; the shared list hook
    // still appends the default-hidden Created/Updated audit pair.
    list: {
      hasUnitMappings: true,
    },
    // The caller supplies a duplicate group in a deterministic order; the
    // first ingredient starts as keeper, with a deliberate picker override.
    mergeable: defineMergeableConfig({
      keeperMode: "ranked",
      isRow: isIngredientMergeRow,
      rowLabel: (row) => <span className="truncate">{row.name}</span>,
      copy: {
        title: "Merge ingredients?",
      },
    }),
  },
  product: {
    ...generatedBrowserRoutes.product,
    color: INK.primary,
    // Note: product renders unit mappings as a custom section (coverage grid +
    // rows table, like ingredient); unit-mappings has no capability-derived
    // common section at all, so this has always been page-owned.
    list: {
      hasUnitMappings: true,
    },
    // The detector supplies duplicate rows in a stable order; the first starts
    // as keeper and the picker remains available for an intentional change.
    mergeable: defineMergeableConfig({
      keeperMode: "ranked",
      isRow: isProductMergeRow,
      rowLabel: (row) => <span className="truncate">{row.name}</span>,
      rowStat: (row) => (
        <>
          {row.gtins.length > 0 && (
            <span>UPC {row.gtins.map(displayGtin).join(", ")}</span>
          )}
          <span>
            {row.sources.length > 0
              ? row.sources.join(", ")
              : "no external ids"}
          </span>
        </>
      ),
      copy: {
        title: "Merge products?",
        description:
          "These rows share the same manufacturer part number, split across retailers. Pick which one to keep — the rest merge into it.",
      },
    }),
  },
  recipe: {
    ...generatedBrowserRoutes.recipe,
    color: INK.primary,
    // Cost/calorie column IDs sort the canonical estimates' known lower amount
    // via jsonb expressions. `source` (SourceType+SourceData)
    // and `yield` (→ servings) are also special-cased there. See recipe/crud.recipeList.
  },
  cookbook: {
    ...generatedBrowserRoutes.cookbook,
    color: INK.primary,
    // Keyed by FK id (rename-safe); no generic list columns or "new" form
    // (cookbooks are created by EPUB import, not a create form).
  },
  location: {
    ...generatedBrowserRoutes.location,
    color: INK.slate,
    // Note: location needs images in a specific position (before child
    // locations), so it's excluded from the generic gallery-Images derivation
    // in `useEntityDetail.ts` (`CUSTOM_IMAGE_PLACEMENT`) and handles its own
    // placement instead. Location supplies its domain columns explicitly;
    // audit dates are shared.
  },
  inventory: {
    ...generatedBrowserRoutes.inventory,
    color: INK.primary,
    // Inventory items have a simple single-section detail page
    // Inventory list has custom columns (image from product, amount instead of name)
  },
  meal: {
    ...generatedBrowserRoutes.meal,
    // Neutral, not amber: the status ramp is reserved for entities whose accent
    // encodes state, and a meal's encodes none. Amber is also already spent on
    // overdue/planned expenses inside the same planning calendar, so a meal
    // wearing it read as a warning about nothing.
    color: INK.slate,
    // Date/Name/Recipes/Cost columns are custom (meal-table.tsx) — Name needs
    // `emptyLabel`, which useStandardColumns's automatic "name" column
    // doesn't support. Audit dates are appended for every entity list.
  },
  project: {
    ...generatedBrowserRoutes.project,
    color: INK.plum,
    // No "new" route — projects are created from a dialog on the list page
    // (mirrors meal), not a dedicated /projects/new form.
  },
  task: {
    ...generatedBrowserRoutes.task,
    color: INK.slate,
  },
  vendor: {
    ...generatedBrowserRoutes.vendor,
    // A quiet roster, not a live money surface — same neutral as location/task.
    color: INK.slate,
    // Default sort ("spend") is declared on `model.sort` in
    // `11-vendor.entity.ts` now, not overridden here.
    // "fixed": the keeper is the vendor being viewed; candidates are every
    // OTHER vendor (mergeVendors has no cross-vendor refusal like
    // mergePurchases' vendor-match check — any two vendors can fold together).
    mergeable: defineMergeableConfig({
      keeperMode: "fixed",
      isRow: isVendorMergeRow,
      candidateQuery: () =>
        entityListFor("vendor").listQueryPlan({
          filters: {},
          // Generous relative to the whole roster (~150 vendors), within
          // MAX_PAGE_SIZE — every other vendor is a merge candidate.
          pagination: { pageIndex: 0, pageSize: 200 },
        }),
      rowLabel: (row) => row.name,
      rowStat: (row) =>
        `${row.purchaseCount} purchase${row.purchaseCount === 1 ? "" : "s"} · ${formatCurrency(row.spend)}`,
      copy: {
        title: (keeperLabel) => <>Merge into {keeperLabel}</>,
        description:
          "Pick other vendors to fold in. Their purchases move onto this vendor — any purchases sharing an order id are folded together — and the folded vendors leave the roster. Website and notes carry over only where this vendor has none.",
        emptyTitle: "Nothing to merge",
        emptyDescription: "No other vendors are on file.",
      },
    }),
  },
  vendorAccount: {
    ...generatedBrowserRoutes.vendorAccount,
    color: INK.slate,
  },
  purchaseImportRun: {
    ...generatedBrowserRoutes.purchaseImportRun,
    color: INK.slate,
  },
  productCategory: {
    ...generatedBrowserRoutes.productCategory,
    color: INK.slate,
  },
  purchase: {
    ...generatedBrowserRoutes.purchase,
    color: INK.primary,
    // A Purchase carries its documents (invoices/receipts), like
    // project's photos — both derive their generic Images section from
    // `capabilities.images === "gallery"` in `useEntityDetail.ts`.
    // No `name` column — a purchase's identity is (vendor, orderId, date), not
    // a free-text name, so the list defines its columns explicitly (like location).
    // "fixed": the keeper is the purchase being viewed; candidates are every
    // OTHER purchase from the same vendor (mergePurchases refuses cross-vendor,
    // and separately refuses when both sides carry a non-null order id — that
    // refusal surfaces as the dialog's error toast, not pre-validated here).
    mergeable: defineMergeableConfig({
      keeperMode: "fixed",
      isRow: isPurchaseMergeRow,
      candidateQuery: (keeper) =>
        entityListFor("purchase").listQueryPlan({
          filters: { vendorId: keeper.vendorId },
          // Generous relative to any one vendor's purchase count, within MAX_PAGE_SIZE.
          pagination: { pageIndex: 0, pageSize: 200 },
        }),
      rowLabel: (row) => purchaseLabel(row),
      rowStat: (row) =>
        `${row.expenseCount} · ${formatCurrency(row.expenseTotal)}`,
      copy: {
        title: (keeperLabel) => <>Merge into {keeperLabel}</>,
        description:
          "Pick other purchases from the same vendor to fold in. Their expenses and documents move onto this purchase; the folded purchases are then deleted.",
        emptyTitle: "Nothing to merge",
        emptyDescription: "This vendor has no other purchases on file.",
        caution:
          "One purchase is one vendor order or receipt event, never a contract — a payment schedule stays as separate purchases. Merge only rows that are genuinely the same transaction.",
      },
    }),
  },
  expense: {
    ...generatedBrowserRoutes.expense,
    color: INK.primary,
  },
  ledgerParty: {
    ...generatedBrowserRoutes.ledgerParty,
    color: INK.slate,
    // Sort direction ("asc", a name roster reads A→Z) is declared on
    // `model.sort` in `07-ledgerParty.entity.ts` now, not overridden here.
  },
  ledgerTransfer: {
    ...generatedBrowserRoutes.ledgerTransfer,
    color: INK.primary,
  },
  financialAccount: {
    ...generatedBrowserRoutes.financialAccount,
    color: INK.slate,
    // Sort direction ("asc", a name roster reads A→Z — the table's blanket
    // descending default was opening this list backwards) is declared on
    // `model.sort` in `13-financialAccount.entity.ts` now, not overridden here.
  },
  financialTransaction: {
    ...generatedBrowserRoutes.financialTransaction,
    color: INK.primary,
  },
  wish: {
    ...generatedBrowserRoutes.wish,
    color: INK.plum,
  },
  "usda-food": {
    ...generatedBrowserRoutes["usda-food"],
    color: INK.primary,
    // USDA foods are read-only, no detail conventions needed. Default sort
    // ("fdc_id") comes from `model.sort` in `17-usda-food.entity.ts`.
  },
  image: {
    ...generatedBrowserRoutes.image,
    color: {
      accent: INK.slate.accent,
      bg: "bg-muted",
      text: "text-muted-foreground",
      border: "border-l-muted-foreground",
    },
    // Note: images use 'filename' not 'name', so we define columns explicitly in ImageList
  },
  planting: {
    ...generatedBrowserRoutes.planting,
    // House domain, matching project's ink — plantings and garden entries are
    // household work like projects/tasks, not a "positive" pantry-stock signal.
    color: INK.plum,
  },
  gardenEntry: {
    ...generatedBrowserRoutes.gardenEntry,
    color: INK.plum,
  },
} as const) satisfies Record<BrowserRoutedEntity, EntityDefinition>;

/** Route unions are derived from the definitions so links cannot drift. */
export type EntityDetailRoute =
  (typeof entityDefinitions)[BrowserRoutedEntity]["routes"]["detail"];

/** Browser presentation exists only for entities with browser routes. */
export const entities = entityDefinitions;

export const isBrowserRoutedEntity = (
  entity: Entity,
): entity is BrowserRoutedEntity => entity in entityDefinitions;

/** Presentation metadata for an entity whose browser-route capability is known. */
export const browserEntityDefinition = (
  entity: BrowserRoutedEntity,
): EntityDefinition => entities[entity];

type GeneratedSortRoster =
  (typeof generatedEntitySort)[keyof typeof generatedEntitySort];

/**
 * The generated `model.sort` roster for an entity, or `undefined` for the few
 * that declare none.
 */
const generatedSortRoster = (entity: Entity): GeneratedSortRoster | undefined =>
  // SAFETY: `generatedEntitySort` is `satisfies Partial<Record<Entity, …>>`,
  // so indexing by any entity is either a roster or absent.
  (generatedEntitySort as Partial<Record<Entity, GeneratedSortRoster>>)[entity];

/**
 * Every entity now carries a browser route (`ledgerParty`/`ledgerTransfer`
 * were the last holdouts), so this always resolves through the registry. Kept
 * as its own accessor — rather than reading `entities[entity]` directly —
 * because a future route-less entity is exactly the case
 * `isBrowserRoutedEntity` exists to guard; a bare index would silently regress
 * if one reappears.
 *
 * Reads `generatedEntitySort` (`@cubby/schemas/entity-sort`) instead of a
 * hand-listed array on the definition: that generated module's only import is
 * `import type { Entity }`, so it carries zero runtime schema dependencies —
 * pulling it into this route-loaded file does not drag Zod validation graphs
 * into the eager client bundle the way importing an entity's own schema
 * module would. Every browser-routed entity, `usda-food` included, now has a
 * generated roster, so no per-entity special case remains here.
 */
export const getSortableFields = (entity: Entity): readonly string[] => {
  if (!isBrowserRoutedEntity(entity)) return [];
  return generatedSortRoster(entity)?.fields ?? [];
};

/**
 * Single source for an entity list's opening sort field: the generated
 * roster's own `default`, or "createdAt" for the rare entity that declares no
 * `model.sort` at all (shouldn't happen for a routed entity today, but keeps
 * this total). Both `entity-list-ssr.ts` and `useEntityListPresentation.tsx`
 * call this so the SSR preload and the mounted table can never open on
 * different sorts.
 */
export const defaultSortFor = (entity: BrowserRoutedEntity): string =>
  generatedSortRoster(entity)?.default ?? "createdAt";

/**
 * Direction `defaultSortFor`'s field opens in. Declared alongside the field
 * itself on `model.sort.direction` (default "desc", right for the date/amount
 * columns most lists open on) — `ledgerParty`/`financialAccount` declare
 * "asc" so their name roster opens A→Z instead of the table's blanket
 * descending default.
 */
export const defaultSortDirectionFor = (
  entity: BrowserRoutedEntity,
): "asc" | "desc" => generatedSortRoster(entity)?.direction ?? "desc";

/**
 * Human-readable label for any entity. `.label` is the manifest's own
 * `names.singular`, stamped from the key by `withEntityNames`, so it cannot
 * drift from the server's error prose — that derives from the same
 * declaration. See {@link getSortableFields} for why this still guards
 * rather than indexing `entities` directly.
 */
export const entityLabel = (entity: Entity): string =>
  isBrowserRoutedEntity(entity) ? entities[entity].label : entity;

export const entityPluralLabel = (entity: Entity): string =>
  isBrowserRoutedEntity(entity)
    ? entities[entity].pluralLabel
    : `${entityLabel(entity)} records`;

/**
 * Path params for an entity's detail route.
 *
 * Every shortcode-bearing entity is keyed `$shortcode`, so this is now uniform —
 * the cookbook `$cookbookId` special case died with the uuid routes. It stays a
 * function rather than an inline `{ shortcode }` because it is the single place
 * a generic "link to this entity" surface (search results, hovercards, the
 * manifest card, table name columns) goes through, and keeping the indirection
 * is what would make a future per-entity divergence a one-line change.
 *
 * `usda` is NOT routed through here — it legitimately keys on an external USDA
 * `fdc_id` rather than a shortcode.
 */
export const entityDetailParams = (shortcode: string) => ({
  shortcode,
});

/**
 * `to` + `params` for a shortcode-bearing entity's detail route, in one call.
 *
 * The `ShortcodeEntity` parameter is doing real work: `Entity` also covers
 * `usda-food`, whose route is `/usda/$id`, so a lookup widened to `Entity`
 * produces a route union that `{ shortcode }` cannot satisfy. Narrowing here
 * is what lets every generic "link to this entity" surface pass a shortcode
 * without a cast.
 */
export const entityDetailLink = (
  entity: Extract<ShortcodeEntity, BrowserRoutedEntity>,
  shortcode: string,
) =>
  ({
    to: entities[entity].routes.detail,
    params: entityDetailParams(shortcode),
  }) as const;

/** Path-params shape accepted by any entity detail `<Link>`. */
export type EntityDetailParams = ReturnType<typeof entityDetailParams>;

/**
 * Render an entity's lucide icon. Useful for entities where you need
 * dynamic icon selection based on entity type.
 *
 * Use `colored` prop to apply the entity's text color for visual identification.
 */
export const EntityIcon = ({
  entity,
  colored,
  className,
  ...props
}: { entity: Entity; colored?: boolean } & LucideProps) => {
  if (!isBrowserRoutedEntity(entity)) return null;
  const def = entities[entity];
  const domain = colored ? domainForEntity(entity) : null;
  const domainColor = domain
    ? `var(${domainWayfinding(domain).accentToken})`
    : undefined;
  const style = { ...props.style };
  if (domainColor) style.color = domainColor;
  return (
    <def.lucideIcon
      {...props}
      className={cn(colored && !domainColor && def.color.text, className)}
      style={style}
    />
  );
};
