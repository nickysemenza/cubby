import {
  type BrowserRoutedEntity,
  entityIndex,
} from "@cubby/schemas/entity-index";
import { displayGtin } from "@cubby/schemas/external-id";
import { productShortcode } from "@cubby/schemas/identifiers";
import { duplicateProductIdentitySchema } from "@cubby/schemas/problems";
import { productListItemOut } from "@cubby/schemas/product";
import { purchaseListItemOut } from "@cubby/schemas/purchase";
import { z } from "zod";

import { entityListFor } from "~/entity/entity-list";
import {
  defineMergeableConfig,
  type MergeableConfig,
  type MergeDisplayRow,
} from "~/entity/types";
import { purchaseLabel } from "~/lib/purchase-label";
import { formatCurrency } from "~/lib/utils";

interface NamedMergeRow extends MergeDisplayRow {
  name: string;
}

const productMergeRowSchema = z.union([
  duplicateProductIdentitySchema.shape.products.element,
  // List actions can run before the relations enrichment supplies the barcode.
  productListItemOut
    .pick({ id: true, name: true, primaryGtin: true })
    .partial({ primaryGtin: true }),
]);
type ProductMergeRow = z.output<typeof productMergeRowSchema>;

interface VendorMergeRow extends MergeDisplayRow {
  name: string;
  purchaseCount: number;
  spend: number;
}

const purchaseMergeRowSchema = purchaseListItemOut.pick({
  id: true,
  date: true,
  displayLabel: true,
  expenseCount: true,
  expenseTotal: true,
  orderId: true,
  vendorId: true,
  vendorName: true,
});
type PurchaseMergeRow = z.output<typeof purchaseMergeRowSchema>;

const isNamedMergeRow = (row: MergeDisplayRow): row is NamedMergeRow =>
  "name" in row && typeof row.name === "string";

const isProductMergeRow = (row: MergeDisplayRow): row is ProductMergeRow =>
  productShortcode.safeParse(row.id).success &&
  productMergeRowSchema.safeParse(row).success;

const isVendorMergeRow = (row: MergeDisplayRow): row is VendorMergeRow =>
  "name" in row &&
  typeof row.name === "string" &&
  "purchaseCount" in row &&
  typeof row.purchaseCount === "number" &&
  "spend" in row &&
  typeof row.spend === "number";

const isPurchaseMergeRow = (row: MergeDisplayRow): row is PurchaseMergeRow =>
  purchaseMergeRowSchema.safeParse(row).success;

/**
 * The merge dialogs that depart from the generic ranked pick: their row
 * shape, keeper mode, candidate query and copy. Loaded with the merge dialog
 * only, so the product and purchase list schemas stay out of the app shell.
 */
/** The bespoke merge dialogs, keyed by entity; the rest use the ranked pick. */
type MergeConfigRegistry = Partial<
  Record<BrowserRoutedEntity, MergeableConfig>
>;

const MERGE_CONFIGS = {
  spendingCategory: defineMergeableConfig({
    keeperMode: "ranked",
    isRow: isNamedMergeRow,
    rowLabel: (row) => <span className="truncate">{row.name}</span>,
    copy: {
      title: "Merge spending categories?",
      description:
        "References and child categories move to the kept category, and the others leave the roster. Review the historical spending impact next.",
    },
  }),
  ingredient: defineMergeableConfig({
    keeperMode: "ranked",
    isRow: isNamedMergeRow,
    rowLabel: (row) => <span className="truncate">{row.name}</span>,
    copy: {
      title: "Merge ingredients?",
    },
  }),
  product: defineMergeableConfig({
    keeperMode: "ranked",
    isRow: isProductMergeRow,
    rowLabel: (row) => <span className="truncate">{row.name}</span>,
    rowStat: (row) => {
      const gtins =
        "gtins" in row ? row.gtins : row.primaryGtin ? [row.primaryGtin] : [];
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
        "These rows share the same manufacturer part number, split across retailers. Pick which one to keep — the rest merge into it.",
    },
  }),
  vendor: defineMergeableConfig({
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
  purchase: defineMergeableConfig({
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
} satisfies MergeConfigRegistry;

const bespokeMergeConfig = (
  registry: MergeConfigRegistry,
  entity: BrowserRoutedEntity,
) => registry[entity];

/**
 * The merge dialog configuration for an entity: its own, or — for any entity
 * the kernel merges without a bespoke dialog — a ranked pick among the
 * selected rows by name. Null where the kernel serves no merge.
 */
export const mergeConfigFor = (
  entity: BrowserRoutedEntity,
): MergeableConfig | null => {
  const bespoke = bespokeMergeConfig(MERGE_CONFIGS, entity);
  if (bespoke !== undefined) return bespoke;
  if (!entityIndex[entity].merge) return null;
  return defineMergeableConfig({
    keeperMode: "ranked",
    isRow: isNamedMergeRow,
    rowLabel: (row) => <span className="truncate">{row.name}</span>,
    copy: {
      title: `Merge ${entityIndex[entity].plural.toLowerCase()}?`,
    },
  });
};
