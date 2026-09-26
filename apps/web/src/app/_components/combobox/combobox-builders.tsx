import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import {
  type LocationShortcode,
  parseShortcodeFor,
  type ProductShortcode,
  type ShortcodeFor,
  type VendorShortcode,
} from "@cubby/schemas/identifiers";
import {
  type ImageRenderStatus,
  type ImageStorageStatus,
  isDisplayableImageFile,
} from "@cubby/schemas/image";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { locationType } from "@cubby/schemas/location";
import type { SearchableEntity, SearchHit } from "@cubby/schemas/search";
import {
  formatCategoryLabel,
  type ProductCategory,
  type ShortcodeType,
} from "@cubby/shared";
import { z } from "zod";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { locationToSegments } from "~/app/_components/locations/location-breadcrumb";
import { LocationPickerThumb } from "~/app/_components/locations/location-picker-thumb";
import { resolveLocationPrimaryVisual } from "~/app/_components/locations/location-visual-resolver";
import { matchKindLabel } from "~/app/_components/search/search-utils";
import { ProjectMark } from "~/app/projects/project-mark";
import { VendorMark } from "~/components/entity/vendor-cell";
import { Image } from "~/components/ui/image";
import { EntityIcon } from "~/entities/entities";

export type ProductPickerIntent = "reference" | "stock";

/** The structural slice of any manifest list/detail row a picker reads. */
export const pickerRecord = z.object({ id: z.string() }).catchall(z.unknown());
export type PickerRecord = z.infer<typeof pickerRecord>;
const pickerAliases = z.array(z.string());
const pickerTitle = z.string();

const formatPickerQuantity = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toLocaleString();

function SearchPickerIcon({
  entity,
  imageUrl,
  typeHint,
}: {
  entity: SearchableEntity;
  imageUrl: string | null;
  typeHint: string | null;
}) {
  const fallback =
    entity === "project" ? (
      <ProjectMark icon={typeHint} />
    ) : (
      <EntityIcon entity={entity} size={14} colored />
    );
  return imageUrl ? (
    <Image
      src={imageUrl}
      alt=""
      displayWidth={24}
      fallback={fallback}
      className="size-6 shrink-0 border border-[var(--border)] object-cover"
    />
  ) : (
    fallback
  );
}

const buildSearchLocationHitComboboxItem = <E extends SearchableEntity>(
  hit: SearchHit,
  shortcode: ShortcodeFor<E>,
  path: NonNullable<SearchHit["locationPath"]>,
): ComboboxItem<ShortcodeFor<E>> => {
  const item = buildLocationComboboxItem({
    id: parseShortcodeFor("location", hit.id),
    name: hit.title,
    type: locationType.safeParse(hit.typeHint).data ?? null,
    ancestors: path,
    coverImage: hit.imageUrl ? { url: hit.imageUrl } : null,
  });
  return { ...item, id: shortcode, shortcode };
};

/** Maps compact indexed-search hits into the picker contract. */
export function buildSearchHitComboboxItem<E extends SearchableEntity>(
  hit: SearchHit,
  entity: E,
): ComboboxItem<ShortcodeFor<E>> {
  const shortcode = parseShortcodeFor(entity, hit.id);
  if (entity === "location" && hit.locationPath) {
    return buildSearchLocationHitComboboxItem(hit, shortcode, hit.locationPath);
  }
  const locationKind =
    entity === "location" ? locationType.safeParse(hit.typeHint).data : null;
  const fallback =
    entity === "location" ? (
      <LocationPickerThumb
        imageUrl={hit.imageUrl}
        type={locationKind ?? null}
      />
    ) : entity === "vendor" ? (
      <VendorMark
        vendor={hit.title}
        vendorId={parseShortcodeFor("vendor", hit.id)}
        logo={hit.imageUrl ? { url: hit.imageUrl } : null}
      />
    ) : (
      <SearchPickerIcon
        entity={entity}
        imageUrl={hit.imageUrl}
        typeHint={hit.typeHint}
      />
    );

  const facts =
    hit.matchField === "title" || hit.matchField === "shortcode"
      ? undefined
      : [hit.matchReason];
  // The embedding fallback is the one match kind a picker cannot justify by
  // looking at it: a lexical hit shows you the letters it matched, an
  // embedding hit shows a row whose name shares nothing with what you typed.
  // Unlabelled it reads as a broken search, so it sinks below the lexical hits
  // under the divider the search results already call "Related".
  const group =
    hit.matchKind === "semantic"
      ? { id: "semantic", label: matchKindLabel.semantic, order: 1 }
      : undefined;

  return {
    // The server applies the entityTypes scope; narrowing it here preserves the
    // branded value each picker writes without ever exposing a private UUID.
    id: shortcode,
    shortcode,
    name: hit.title,
    secondary: hit.subtitle ?? hit.typeHint ?? undefined,
    detail: hit.subtitle && hit.typeHint ? hit.typeHint : undefined,
    presentation:
      facts || group
        ? { ...(facts && { facts }), ...(group && { group }) }
        : undefined,
    icon: fallback,
  };
}

// Builders take minimal structural shapes (not the full *Out types) so both
// picker results and list-row relation summaries pass without casts.
export const buildProductComboboxItem = (
  product: {
    id: ProductShortcode;
    name: string;
    manufacturer: string;
    category?: ProductCategory | null;
    coverImageUrl?: string | null;
    images?: Array<{
      url: string;
      contentType: string;
      renderStatus?: ImageRenderStatus | null;
      storageStatus?: ImageStorageStatus | null;
    }>;
    aliases?: string[] | null;
    quantityLedger?: {
      acquiredUnits: number;
      exitedUnits: number;
      expectedQuantity: number;
      unknownAcquisitionLines: number;
      unknownExitLines: number;
      locationCount: number;
    };
    onHand?:
      | { state: "none" }
      | { state: "counted"; units: number }
      | { state: "mixed" };
    onHandUnits?: number | null;
    inventoryEntry?: Array<{
      amount: { value: number; unit: string };
    }>;
  },
  intent: ProductPickerIntent = "reference",
): ComboboxItem<ProductShortcode> => {
  const ledger = product.quantityLedger;
  const onHand = product.onHand ?? deriveProductOnHand(product, ledger);
  const coverImageUrl =
    product.coverImageUrl ??
    product.images?.find(isDisplayableImageFile)?.url ??
    null;
  const base = productPickerBase(product, coverImageUrl);
  return !ledger || !onHand
    ? base
    : withProductInventoryPresentation(base, ledger, onHand, intent);
};

type ProductPickerInput = Parameters<typeof buildProductComboboxItem>[0];
type DerivedOnHand =
  | { state: "none" }
  | { state: "counted"; units: number }
  | { state: "mixed" };

function deriveProductOnHand(
  product: ProductPickerInput,
  ledger: NonNullable<ProductPickerInput["quantityLedger"]> | undefined,
): DerivedOnHand | undefined {
  const inventoryUnits = new Set(
    product.inventoryEntry?.map((entry) => entry.amount.unit) ?? [],
  );
  if (product.onHandUnits != null)
    return { state: "counted", units: product.onHandUnits };
  if (product.inventoryEntry == null || ledger == null) return undefined;
  if (inventoryUnits.size > 1) return { state: "mixed" };
  if (product.inventoryEntry.length === 0 && ledger.locationCount === 0)
    return { state: "none" };
  return {
    state: "counted",
    units:
      product.inventoryEntry.reduce(
        (sum, entry) => sum + entry.amount.value,
        0,
      ) + ledger.locationCount,
  };
}

function productPickerBase(
  product: ProductPickerInput,
  coverImageUrl: string | null,
): ComboboxItem<ProductShortcode> {
  return {
    id: product.id,
    shortcode: product.id,
    name: product.name,
    aliases: product.aliases ?? [],
    secondary: product.manufacturer,
    detail: product.category
      ? formatCategoryLabel(product.category)
      : undefined,
    icon: (
      <SearchPickerIcon
        entity="product"
        imageUrl={coverImageUrl}
        typeHint={null}
      />
    ),
  };
}

function withProductInventoryPresentation(
  base: ComboboxItem<ProductShortcode>,
  ledger: NonNullable<ProductPickerInput["quantityLedger"]>,
  onHand: DerivedOnHand,
  intent: ProductPickerIntent,
): ComboboxItem<ProductShortcode> {
  const unknownLines = ledger.unknownAcquisitionLines + ledger.unknownExitLines;
  const expected = ledger.expectedQuantity;
  const knownOnHand =
    onHand.state === "none"
      ? 0
      : onHand.state === "counted"
        ? onHand.units
        : null;
  const facts = [
    knownOnHand === null
      ? "Mixed units on hand"
      : `${formatPickerQuantity(knownOnHand)} on hand / ${formatPickerQuantity(expected)} expected`,
  ];
  if (unknownLines > 0) {
    facts.push(
      `${unknownLines} ${unknownLines === 1 ? "line" : "lines"} without quantity`,
    );
  }

  if (intent === "reference") return { ...base, presentation: { facts } };

  const uncertain = unknownLines > 0 || knownOnHand === null || expected < 0;
  if (uncertain)
    return productPickerInventoryGroup(
      base,
      { id: "check", label: "Check quantity", order: 1 },
      { label: "Check quantity", tone: "warning" },
      facts,
    );

  const need = expected - knownOnHand;
  if (need > 0)
    return productPickerInventoryGroup(
      base,
      { id: "needs-stock", label: "Needs stocking", order: 0 },
      { label: `Need ${formatPickerQuantity(need)}`, tone: "positive" },
      facts,
    );

  const returned =
    expected === 0 && knownOnHand === 0 && ledger.exitedUnits > 0;
  return {
    ...base,
    presentation: {
      group: { id: "other", label: "Other products", order: 2 },
      status: {
        label: returned
          ? "Returned"
          : knownOnHand > 0
            ? "Already on hand"
            : "None expected",
      },
      facts,
    },
  };
}

function productPickerInventoryGroup(
  base: ComboboxItem<ProductShortcode>,
  group: { id: string; label: string; order: number },
  status: { label: string; tone: "warning" | "positive" },
  facts: string[],
): ComboboxItem<ProductShortcode> {
  return { ...base, presentation: { group, status, facts } };
}

/**
 * `ancestors` and `coverImage` are optional because three shapes feed this
 * builder: the search endpoint (both present), a by-shortcode read (ancestors
 * derived from its nested parent chain, see `locationToSegments`), and a
 * freshly-created location (neither — it has no parent chain loaded yet).
 *
 * When `ancestors` is present, the row also carries `presentation.group`
 * (the root location) and `presentation.depth` (the path length) — the
 * blank-query list picker reads as a tree the same way `productCategory`'s
 * does, instead of a flat alphabetical roster. A root location (empty
 * `ancestors`) groups under itself. Every group gets the same `order`
 * (0): the list is already server-sorted so siblings arrive contiguous,
 * and `EntityPicker`'s stable sort leaves same-order rows in that order.
 */
export const buildLocationComboboxItem = (location: {
  id: LocationShortcode;
  name: string;
  type: LocationType | null;
  aliases?: string[] | null;
  ancestors?: Array<{ id?: string; name: string }> | null;
  coverImage?: { url: string } | null;
}): ComboboxItem<LocationShortcode> => {
  const ancestors = location.ancestors;
  const rootAncestor = ancestors?.[0];
  const root = {
    id: rootAncestor?.id ?? location.id,
    name: rootAncestor?.name ?? location.name,
  };
  return {
    id: location.id,
    shortcode: location.id,
    name: location.name,
    aliases: location.aliases ?? [],
    secondary: location.type ?? undefined,
    detail: ancestors?.length
      ? ancestors.map((ancestor) => ancestor.name).join(" › ")
      : undefined,
    icon: (
      <LocationPickerThumb
        imageUrl={location.coverImage?.url}
        type={location.type}
      />
    ),
    presentation: ancestors
      ? {
          group: { id: root.id, label: root.name, order: 0 },
          depth: ancestors.length,
        }
      : undefined,
  };
};

/**
 * Same row, built from a detail-shaped location — a by-shortcode read or a
 * just-created one. Those carry the ancestor chain nested under `parent` and
 * the full image list, rather than the flat `ancestors` / `coverImage` the
 * search endpoint returns.
 */
export const buildLocationComboboxItemFromDetail = (
  location: InfLocation,
): ComboboxItem<LocationShortcode> =>
  buildLocationComboboxItem({
    ...location,
    // `locationToSegments` is root→leaf and includes the location itself.
    ancestors: locationToSegments(location).slice(0, -1),
    coverImage: resolveLocationPrimaryVisual(location).image,
  });

/**
 * A picker row for any list-backed manifest entity: the declared
 * `presentation.titleField` is the name, and declared aliases stay searchable.
 * Product, location and vendor keep their own builders above/below because
 * their rows carry stock, tree, and roster evidence.
 */
export function buildRecordComboboxItem<E extends ShortcodeType>(
  entity: E,
  record: PickerRecord,
): ComboboxItem<ShortcodeFor<E>> {
  const shortcode = parseShortcodeFor(entity, record.id);
  const title = record[entityInspectorMetadata[entity].titleField];
  const aliases = pickerAliases.safeParse(record.aliases).data;
  return {
    id: shortcode,
    shortcode,
    name: pickerTitle.safeParse(title).data ?? shortcode,
    ...(aliases && { aliases }),
    icon: <EntityIcon entity={entity} size={14} colored />,
  };
}

type VendorPickerInput = {
  id: VendorShortcode;
  name: string;
  count?: number;
  logo?: { url: string } | null;
};

/**
 * One vendor row, two identities. `itemId: "shortcode"` is for persisted
 * vendor relations (purchase writes keep `VendorShortcode`); `itemId: "name"`
 * is for the expense vendor field, which resolves server-side by exact,
 * case-sensitive name match through `findOrCreateVendor` (see the doc on
 * `WithVendorSearch` in `with-vendor-search.tsx`) and so must key its
 * combobox item on the name, not the id.
 */
export function buildVendorComboboxItem(
  vendor: VendorPickerInput,
  options: { itemId: "shortcode" },
): ComboboxItem<VendorShortcode>;
export function buildVendorComboboxItem(
  vendor: VendorPickerInput,
  options: { itemId: "name" },
): ComboboxItem<string>;
export function buildVendorComboboxItem(
  vendor: VendorPickerInput,
  options: { itemId: "name" | "shortcode" },
): ComboboxItem<string> {
  return options.itemId === "shortcode"
    ? vendorComboboxItem(vendor, vendor.id)
    : vendorComboboxItem(vendor, vendor.name);
}

/** The one vendor item body; the id's type follows the identity the caller picked. */
const vendorComboboxItem = <Id extends string>(
  vendor: VendorPickerInput,
  id: Id,
): ComboboxItem<Id> => ({
  id,
  shortcode: vendor.id,
  name: vendor.name,
  presentation:
    vendor.count == null
      ? undefined
      : {
          facts: [
            `${vendor.count} ${vendor.count === 1 ? "purchase" : "purchases"}`,
          ],
        },
  icon: (
    <VendorMark vendor={vendor.name} vendorId={vendor.id} logo={vendor.logo} />
  ),
});
