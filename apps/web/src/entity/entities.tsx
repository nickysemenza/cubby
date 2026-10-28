import { purchaseFieldEnvelopeSchemas } from "@cubby/schemas/compiler/generated/entity-field-envelopes/purchase";
import { vendorFieldEnvelopeSchemas } from "@cubby/schemas/compiler/generated/entity-field-envelopes/vendor";
import { productListItemOut } from "@cubby/schemas/entities/product";
import type { Entity } from "@cubby/schemas/entity";
import type {
  BrowserRoutedEntity,
  ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { entityRoster } from "@cubby/schemas/entity-roster";
import { displayGtin } from "@cubby/schemas/external-id";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { productShortcode } from "@cubby/schemas/identifiers";
import { duplicateProductIdentitySchema } from "@cubby/schemas/problems";
import { countLabel } from "@cubby/shared/pluralize";
import type { IconProps } from "@phosphor-icons/react/lib";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { entityListFor } from "~/entity/entity-list";
import { formatCurrency } from "~/lib/number-format";
import { purchaseLabel } from "~/lib/purchase-label";
import { cn } from "~/lib/utils";
import {
  domainForEntity,
  domainIconClass,
} from "~/ui/navigation/domain-wayfinding";

import { generatedBrowserDefinitions } from "./generated/entity-icons.gen";
import { generatedSortRoster } from "./sortable-fields";
import {
  defineMergeableConfig,
  type EntityColor,
  type EntityDefinition,
  type MergeableConfig,
  type MergeDisplayRow,
} from "./types";

interface NamedMergeRow extends MergeDisplayRow {
  name: string;
}

const productMergeRowSchema = z.union([
  duplicateProductIdentitySchema.shape.products.element,
  // Suggestion merge reviews carry only Product identity; list rows may also
  // omit the barcode until relation enrichment completes.
  productListItemOut.pick({ id: true, name: true }).extend({
    fields: productListItemOut.shape.fields
      .pick({ primaryGtin: true })
      .partial()
      .optional(),
  }),
]);
type ProductMergeRow = z.output<typeof productMergeRowSchema>;

const vendorMergeRowSchema = vendorFieldEnvelopeSchemas.list
  .pick({ id: true, name: true })
  .extend({
    fields: vendorFieldEnvelopeSchemas.list.shape.fields.pick({
      purchaseCount: true,
      spend: true,
    }),
  });
type VendorMergeRow = z.output<typeof vendorMergeRowSchema>;
const purchaseMergeRowSchema = purchaseFieldEnvelopeSchemas.list
  .pick({
    id: true,
    date: true,
    displayLabel: true,
    orderId: true,
    vendorName: true,
  })
  .extend({
    fields: purchaseFieldEnvelopeSchemas.list.shape.fields.pick({
      expenseCount: true,
      expenseTotal: true,
      vendorId: true,
    }),
  });
type PurchaseMergeRow = z.output<typeof purchaseMergeRowSchema>;

const isNamedMergeRow = (row: MergeDisplayRow): row is NamedMergeRow =>
  "name" in row && typeof row.name === "string";

const isProductMergeRow = (row: MergeDisplayRow): row is ProductMergeRow =>
  productShortcode.safeParse(row.id).success &&
  productMergeRowSchema.safeParse(row).success;

const isVendorMergeRow = (row: MergeDisplayRow): row is VendorMergeRow =>
  vendorMergeRowSchema.safeParse(row).success;

const isPurchaseMergeRow = (row: MergeDisplayRow): row is PurchaseMergeRow =>
  purchaseMergeRowSchema.safeParse(row).success;

/**
 * The four inks an entity can wear. `accent` feeds the `--page-accent` /
 * `--row-accent` CSS variables (styles.css) for decorative chrome — the
 * page-hero accent bar, table row-hover/selected bars — while the tailwind
 * trio dresses icon tiles and badges.
 *
 * Field Guide: page and row accents resolve through the five domain
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

/** Generated defaults retain each routed entity's concrete route literal types. */
const defaultDefinitions = generatedBrowserDefinitions(INK.slate);

const entityDefinitions = {
  ...defaultDefinitions,
  spendingCategory: {
    ...defaultDefinitions.spendingCategory,
    // The selected categories in list order; the first starts as keeper.
    // Confirming opens the historical spending review that applies the merge.
    mergeable: defineMergeableConfig({
      keeperMode: "ranked",
      isRow: isNamedMergeRow,
      rowLabel: (row) => <span className="truncate">{row.name}</span>,
      copy: {
        title: "Merge spending categories?",
        description:
          "References and child categories move to the kept category, and the others leave the roster. Review the historical spending impact next.",
      },
    }),
  },
  ingredient: {
    ...defaultDefinitions.ingredient,
    color: {
      accent: INK.slate.accent,
      bg: "bg-warning/20",
      text: "text-accent-foreground",
      border: "border-l-warning",
    },
    // Note: ingredient uses UnitMappingsTable (different from UnitMappingDisplay),
    // so unit-mappings is handled as a custom section
    list: {
      hasUnitMappings: true,
    },
    // The caller supplies a duplicate group in a deterministic order; the
    // first ingredient starts as keeper, with a deliberate picker override.
    mergeable: defineMergeableConfig({
      keeperMode: "ranked",
      isRow: isNamedMergeRow,
      rowLabel: (row) => <span className="truncate">{row.name}</span>,
      copy: {
        title: "Merge ingredients?",
      },
    }),
  },
  product: {
    ...defaultDefinitions.product,
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
      rowStat: (row) => {
        const primaryGtin =
          "fields" in row && row.fields?.primaryGtin
            ? fieldValueOf(row.fields.primaryGtin)
            : null;
        const gtins =
          "gtins" in row ? row.gtins : primaryGtin ? [primaryGtin] : [];
        return (
          <>
            {gtins.length > 0 && (
              <span>UPC {gtins.map(displayGtin).join(", ")}</span>
            )}
            <span>
              {"sources" in row
                ? row.sources.length > 0
                  ? row.sources.join(", ")
                  : "no external ids"
                : "Review external identities in the merge preview"}
            </span>
          </>
        );
      },
      copy: {
        title: "Merge products?",
        description:
          "These rows share the same brandName part number, split across retailers. Pick which one to keep — the rest merge into it.",
      },
    }),
  },
  recipe: {
    ...defaultDefinitions.recipe,
    color: INK.primary,
    // Cost/calorie column IDs sort the canonical estimates' known lower amount
    // via jsonb expressions. `source` (sourceType + its stored provenance)
    // and `yield` (→ servings) are also special-cased there. See recipe/crud.recipeList.
  },
  cookbook: {
    ...defaultDefinitions.cookbook,
    color: INK.primary,
    // Keyed by FK id (rename-safe); no generic list columns or "new" form
    // (cookbooks are created by EPUB import, not a create form).
  },
  inventory: {
    ...defaultDefinitions.inventory,
    color: INK.primary,
    // Inventory items have a simple single-section detail page
    // Inventory list has custom columns (image from product, amount instead of name)
  },
  project: {
    ...defaultDefinitions.project,
    color: INK.plum,
    // No "new" route — projects are created from a dialog on the list page
    // (mirrors meal), not a dedicated /projects/new form.
  },
  vendor: {
    ...defaultDefinitions.vendor,
    // A quiet roster, not a live money surface — same neutral as location/task.
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
        `${countLabel(fieldValueOf(row.fields.purchaseCount) ?? 0, "purchase")} · ${formatCurrency(fieldValueOf(row.fields.spend) ?? 0)}`,
      copy: {
        title: (keeperLabel) => <>Merge into {keeperLabel}</>,
        description:
          "Pick other vendors to fold in. Their purchases move onto this vendor — any purchases sharing an order id are folded together — and the folded vendors leave the roster. Website and notes carry over only where this vendor has none.",
        emptyTitle: "Nothing to merge",
        emptyDescription: "No other vendors are on file.",
      },
    }),
  },
  purchase: {
    ...defaultDefinitions.purchase,
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
          filters: {
            vendorId: fieldValueOf(keeper.fields.vendorId) ?? undefined,
          },
          // Generous relative to any one vendor's purchase count, within MAX_PAGE_SIZE.
          pagination: { pageIndex: 0, pageSize: 200 },
        }),
      rowLabel: (row) =>
        purchaseLabel({
          date: row.date,
          displayLabel: row.displayLabel,
          orderId: row.orderId,
          vendorName: row.vendorName,
        }),
      rowStat: (row) =>
        `${fieldValueOf(row.fields.expenseCount) ?? 0} · ${formatCurrency(fieldValueOf(row.fields.expenseTotal) ?? 0)}`,
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
    ...defaultDefinitions.expense,
    color: INK.primary,
  },
  ledgerTransfer: {
    ...defaultDefinitions.ledgerTransfer,
    color: INK.primary,
  },
  financialTransaction: {
    ...defaultDefinitions.financialTransaction,
    color: INK.primary,
  },
  wish: {
    ...defaultDefinitions.wish,
    color: INK.plum,
  },
  "usda-food": {
    ...defaultDefinitions["usda-food"],
    color: INK.primary,
    // USDA foods are read-only, no detail conventions needed. Default sort
    // ("fdc_id") comes from `model.sort` in `17-usda-food.entity.ts`.
  },
  image: {
    ...defaultDefinitions.image,
    color: {
      accent: INK.slate.accent,
      bg: "bg-muted",
      text: "text-muted-foreground",
      border: "border-l-muted-foreground",
    },
    // Note: images use 'filename' not 'name', so we define columns explicitly in ImageList
  },
  plant: {
    ...defaultDefinitions.plant,
    color: INK.plum,
  },
  planting: {
    ...defaultDefinitions.planting,
    // House domain, matching project's ink — plantings and garden entries are
    // household work like projects/tasks, not a "positive" pantry-stock signal.
    color: INK.plum,
  },
  gardenEntry: {
    ...defaultDefinitions.gardenEntry,
    color: INK.plum,
  },
} satisfies Record<BrowserRoutedEntity, EntityDefinition>;

/** Route unions are derived from the definitions so links cannot drift. */
export type EntityDetailRoute =
  (typeof entityDefinitions)[BrowserRoutedEntity]["routes"]["detail"];

/** Browser presentation exists only for entities with browser routes. */
export const entities = entityDefinitions;

/**
 * The merge dialog configuration for an entity: its own, or — for any entity
 * the kernel merges without a bespoke dialog — a ranked pick among the
 * selected rows by name. Null where the kernel serves no merge.
 */
export const mergeConfigFor = (
  entity: BrowserRoutedEntity,
): MergeableConfig | null => {
  const definition = entities[entity];
  if ("mergeable" in definition && definition.mergeable)
    return definition.mergeable;
  if (!entityRoster[entity].merge) return null;
  return defineMergeableConfig({
    keeperMode: "ranked",
    isRow: isNamedMergeRow,
    rowLabel: (row) => <span className="truncate">{row.name}</span>,
    copy: {
      title: `Merge ${entityRoster[entity].plural.toLowerCase()}?`,
    },
  });
};

export const isBrowserRoutedEntity = (
  entity: Entity,
): entity is BrowserRoutedEntity => entity in entityDefinitions;

/** Presentation metadata for an entity whose browser-route capability is known. */
export const browserEntityDefinition = (
  entity: BrowserRoutedEntity,
): EntityDefinition => entities[entity];

/**
 * Every entity now carries a browser route (`ledgerParty`/`ledgerTransfer`
 * were the last holdouts), so this always resolves through the registry. Kept
 * as its own accessor — rather than reading `entities[entity]` directly —
 * because a future route-less entity is exactly the case
 * `isBrowserRoutedEntity` exists to guard; a bare index would silently regress
 * if one reappears.
 *
 * Sort capabilities come from the current route's scoped metadata slice.
 */
export const getSortableFields = (
  queryClient: QueryClient,
  entity: Entity,
): readonly string[] => {
  if (!isBrowserRoutedEntity(entity)) return [];
  return generatedSortRoster(queryClient, entity)?.fields ?? [];
};

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
 * Render an entity's Phosphor icon. Useful for entities where you need
 * dynamic icon selection based on entity type.
 *
 * Identity marks use color by default: domain entities use their shared hue,
 * while unclassified entities keep their declared entity tone.
 */
export const EntityIcon = ({
  entity,
  className,
  ...props
}: { entity: Entity } & IconProps) => {
  if (!isBrowserRoutedEntity(entity)) return null;
  const def = entities[entity];
  const domain = domainForEntity(entity);
  return (
    <def.phosphorIcon
      {...props}
      className={cn(
        domain ? domainIconClass(domain) : def.color.text,
        className,
      )}
    />
  );
};
