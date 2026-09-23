import type { DataQuality } from "@cubby/schemas/data-quality";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { LocationAncestorOut } from "@cubby/schemas/location";
import type { ProductCategorySummary } from "@cubby/schemas/product-category-fields";

import type {
  cookbook,
  ingredient,
  inventoryEntry,
  location,
  product,
  productUnitMappings,
} from "~/server/db/schema";
import type {
  MappableImageRecord,
  RowWithOptionalAliases,
  RowWithOptionalAliasesAndTags,
} from "~/server/repo/database-helpers";
import type { LocationIdentityProductRow } from "~/server/repo/location/internal-types";

import type { MappableProductExternalId } from "./external-id-types";
import type { ProductPricing } from "./pricing";
import type { QuantityLedger } from "./quantity-ledger";

type ProductSelect = RowWithOptionalAliases<typeof product.$inferSelect> & {
  classificationEvidence: string;
  category: ProductCategorySummary | null;
};
type LocationSelect = RowWithOptionalAliasesAndTags<
  typeof location.$inferSelect
>;

/**
 * A breadcrumb rung on the detail read, carrying the thumbnail its link draws.
 * Both attached by `hydrateProductLocationBreadcrumbs`, never selected.
 */
type ProductLocationAncestor = LocationAncestorOut & {
  displayImage: ImageUrlSummary | null;
};

export type ProductDeepDB = ProductSelect & {
  pricing?: ProductPricing;
  // Batch-resolved by the caller via `getProductCoverImageUrlsByProductIds`
  // (same rule the picker uses). Optional: callers that never asked for it
  // (e.g. ingredient-relation reads) fall back to `null` in the mapper.
  coverImageUrl?: string | null;
  ingredient: typeof ingredient.$inferSelect | null;
  growsPlant?: { shortcode: string } | null;
  unitMappings: Array<typeof productUnitMappings.$inferSelect>;
  externalIds: MappableProductExternalId[];
  inventoryEntry: Array<
    typeof inventoryEntry.$inferSelect & {
      location: LocationSelect & {
        ancestors?: ProductLocationAncestor[];
        displayImage?: ImageUrlSummary | null;
        product?: LocationIdentityProductRow | null;
        images: Array<{
          image: MappableImageRecord;
          deletedAt?: Date | null;
        }>;
      };
    }
  >;
  locations?: Array<
    typeof location.$inferSelect & {
      ancestors?: ProductLocationAncestor[];
      displayImage?: ImageUrlSummary | null;
    }
  >;
  images: Array<{
    image: MappableImageRecord;
    deletedAt?: Date | null;
  }>;
  quantityLedger: QuantityLedger;
  componentCount: number;
  cookbooks?: Array<
    typeof cookbook.$inferSelect & {
      recipes?: Array<{ deletedAt: Date | null }>;
    }
  >;
};

export type ProductListDB = ProductSelect & {
  pricing?: ProductPricing;
  dataQuality: DataQuality;
  ingredient: typeof ingredient.$inferSelect | null;
  growsPlant?: { shortcode: string } | null;
  unitMappings: Array<typeof productUnitMappings.$inferSelect>;
  externalIds: MappableProductExternalId[];
  inventoryEntry: Array<
    typeof inventoryEntry.$inferSelect & {
      location: LocationSelect;
    }
  >;
  images: Array<{
    image: MappableImageRecord;
    deletedAt?: Date | null;
  }>;
  expenseCount: number | string;
  componentCount: number | string;
  // `::double precision` cast in the extras SQL comes back as a plain
  // number (unlike the bigint count() above), but the mapper still coerces
  // with Number() defensively — same as `purchaseExpenseTotal` in
  // repo/purchase.ts.
  expenseTotal: number;
  purchaseDate: string | null;
  quantityLedger: QuantityLedger;
};
