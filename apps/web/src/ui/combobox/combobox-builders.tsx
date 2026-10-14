import { displayImagesField } from "@cubby/schemas/display-images";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
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

import { RecordEmoji } from "~/entity/components/record-emoji";
import { VendorMark } from "~/entity/components/vendor-cell";
import { EntityIcon, entityLabel } from "~/entity/entities";
import { compactFieldText } from "~/entity/field-text";
import { locationToSegments } from "~/features/locations/location-breadcrumb";
import { LocationIcon } from "~/features/locations/location-icons";
import { resolveLocationPrimaryVisual } from "~/features/locations/location-visual-resolver";
import { matchKindLabel } from "~/features/search/search-utils";
import { formatCount } from "~/lib/utils";
import type {
  ComboboxItem,
  PickerChip,
  PickerThumb,
} from "~/ui/combobox/combobox-types";

export type ProductPickerIntent = "reference" | "stock";

/** The structural slice of any manifest list/detail row a picker reads. */
export const pickerRecord = z.object({ id: z.string() }).catchall(z.unknown());
export type PickerRecord = z.infer<typeof pickerRecord>;
const pickerAliases = z.array(z.string());
const pickerTitle = z.string();
const emojiValue = z.string().nullable().optional();

/** Trailing chips a row shows at most — the inspo row: one or two figures. */
const MAX_TRAILING = 2;

/**
 * A record's row data from its manifest phone-row projection: the field in
 * the `subtitle` slot reads inline after the name, and `trailing` fields
 * become right-aligned chips. The same declaration drives the phone list row
 * and native, so a picker row says what the record's card says.
 */
export function recordRowProjection<E extends ShortcodeType>(
  entity: E,
  record: PickerRecord,
) {
  const titleField = entitySummary[entity].titleField;
  const slotted = entityFieldModels[entity].fields
    .flatMap((field) => {
      const mobile = field.display.mobile;
      if (!mobile || field.key === titleField) return [];
      return [{ field, slot: mobile.slot, priority: mobile.priority ?? 50 }];
    })
    .sort((a, b) => a.priority - b.priority);
  const text = (entry: (typeof slotted)[number]) =>
    compactFieldText(entity, record, entry.field);
  const secondary = slotted
    .filter((entry) => entry.slot === "subtitle")
    .map(text)
    .find((value): value is string => !!value);
  const trailing = slotted
    .filter((entry) => entry.slot === "trailing")
    .flatMap((entry): PickerChip[] => {
      const value = text(entry);
      return value ? [{ text: value }] : [];
    })
    .slice(0, MAX_TRAILING);
  return { ...(secondary && { secondary }), trailing };
}

/** `displayImages[0]` is the server-resolved cover for every entity that
 * declares images; the record's emoji (or entity glyph) stands in otherwise. */
function recordThumb(entity: ShortcodeType, record: PickerRecord): PickerThumb {
  const cover = displayImagesField.safeParse(record.displayImages).data?.[0];
  return {
    imageUrl: cover?.url ?? null,
    fallback: (
      <RecordEmoji
        entity={entity}
        emoji={emojiValue.safeParse(record.emoji).data}
        size={14}
      />
    ),
  };
}

/**
 * A picker row for any manifest entity: the declared `titleField` is the
 * name, aliases stay searchable, the cover is the picture, and the phone-row
 * projection supplies the inline secondary and trailing chips.
 */
export function buildRecordComboboxItem<E extends ShortcodeType>(
  entity: E,
  record: PickerRecord,
): ComboboxItem<ShortcodeFor<E>> {
  const shortcode = parseShortcodeFor(entity, record.id);
  const title = record[entitySummary[entity].titleField];
  const aliases = pickerAliases.safeParse(record.aliases).data;
  const { secondary, trailing } = recordRowProjection(entity, record);
  return {
    id: shortcode,
    shortcode,
    // A record without its declared title is unnamed, never its code.
    name:
      pickerTitle.safeParse(title).data ??
      `Untitled ${entityLabel(entity).toLowerCase()}`,
    ...(aliases && { aliases }),
    thumb: recordThumb(entity, record),
    ...(secondary && { secondary }),
    ...(trailing.length > 0 && { presentation: { trailing } }),
  };
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
  // A non-title match says why the row is here; a title match is self-evident.
  const matchReason =
    hit.matchField === "title" || hit.matchField === "shortcode"
      ? undefined
      : hit.matchReason;
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
    // The server applies the entityKinds scope; narrowing it here preserves the
    // branded value each picker writes without ever exposing a private UUID.
    id: shortcode,
    shortcode,
    name: hit.title,
    thumb: searchHitThumb(hit, entity),
    secondary: hit.subtitle ?? hit.typeHint ?? undefined,
    ...(matchReason && { detail: matchReason }),
    ...(group && { presentation: { group } }),
  };
}

function searchHitThumb(hit: SearchHit, entity: SearchableEntity): PickerThumb {
  if (entity === "vendor")
    return vendorThumb({
      id: parseShortcodeFor("vendor", hit.id),
      name: hit.title,
      logo: hit.imageUrl ? { url: hit.imageUrl } : null,
    });
  return {
    imageUrl: hit.imageUrl,
    fallback: hit.emoji ? (
      <RecordEmoji entity={entity} emoji={hit.emoji} />
    ) : (
      <EntityIcon entity={entity} size={14} colored />
    ),
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
  const secondary = [
    product.manufacturer,
    product.category ? formatCategoryLabel(product.category) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: product.id,
    shortcode: product.id,
    name: product.name,
    aliases: product.aliases ?? [],
    ...(secondary && { secondary }),
    thumb: {
      imageUrl: coverImageUrl,
      fallback: <EntityIcon entity="product" size={14} colored />,
    },
  };
}

/**
 * Stock evidence as trailing chips: what is on hand (and expected, when it
 * differs), how many ledger lines lack a quantity, and — for a stock picker —
 * the cue and group that rank the roster.
 */
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
  const evidence: PickerChip[] = [
    knownOnHand === null
      ? { text: "Mixed units on hand", tone: "warning" }
      : knownOnHand === expected
        ? { text: `${formatCount(knownOnHand, 3)} on hand` }
        : {
            text: `${formatCount(knownOnHand, 3)} on hand / ${formatCount(expected, 3)} expected`,
          },
  ];
  if (unknownLines > 0)
    evidence.push({
      text: `${unknownLines} ${unknownLines === 1 ? "line" : "lines"} without quantity`,
      tone: "warning",
    });

  if (intent === "reference")
    return { ...base, presentation: { trailing: evidence } };

  const uncertain = unknownLines > 0 || knownOnHand === null || expected < 0;
  if (uncertain)
    return {
      ...base,
      presentation: {
        group: { id: "check", label: "Check quantity", order: 1 },
        trailing: [{ text: "Check quantity", tone: "warning" }, ...evidence],
      },
    };

  const need = expected - knownOnHand;
  if (need > 0)
    return {
      ...base,
      presentation: {
        group: { id: "needs-stock", label: "Needs stocking", order: 0 },
        trailing: [
          { text: `Need ${formatCount(need, 3)}`, tone: "positive" },
          ...evidence,
        ],
      },
    };

  const returned =
    expected === 0 && knownOnHand === 0 && ledger.exitedUnits > 0;
  return {
    ...base,
    presentation: {
      group: { id: "other", label: "Other products", order: 2 },
      trailing: [
        {
          text: returned
            ? "Returned"
            : knownOnHand > 0
              ? "Already on hand"
              : "None expected",
        },
        ...evidence,
      ],
    },
  };
}

/**
 * `ancestors` and `coverImage` are optional because three shapes feed this
 * builder: the search endpoint (both present), a by-shortcode read (ancestors
 * derived from its nested parent chain, see `locationToSegments`), and a
 * freshly-created location (neither — it has no parent chain loaded yet).
 *
 * With `ancestors`, the row carries `presentation.group` (the root location)
 * and `presentation.depth` (the path length), so the roster reads as a tree
 * under its root headers and the breadcrumb is not repeated on every row.
 * Every group gets the same `order` (0): the list is already server-sorted so
 * siblings arrive contiguous, and `Picker`'s stable sort keeps that order.
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
    // The tree's root header and indent show the path, so rows stay one
    // line; the path stays searchable ("shelf 1" exists in four rooms).
    aliases: [
      ...(location.aliases ?? []),
      ...(ancestors?.length
        ? [ancestors.map((ancestor) => ancestor.name).join(" › ")]
        : []),
    ],
    secondary: location.type ?? undefined,
    thumb: {
      imageUrl: location.coverImage?.url ?? null,
      fallback: (
        <LocationIcon
          type={location.type}
          product={null}
          size={14}
          className="text-muted-foreground"
        />
      ),
    },
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

type VendorPickerInput = {
  id: VendorShortcode;
  name: string;
  count?: number;
  logo?: { url: string } | null;
};

/** A vendor's mark (logo, else monogram) as the row and field picture. */
function vendorThumb(vendor: VendorPickerInput): PickerThumb {
  return {
    imageUrl: null,
    shape: "round",
    fallback: (
      <VendorMark
        vendor={vendor.name}
        vendorId={vendor.id}
        logo={vendor.logo}
        className="size-full"
      />
    ),
  };
}

/**
 * One vendor row, two identities. `itemId: "shortcode"` is for persisted
 * vendor relations (purchase writes keep `VendorShortcode`); `itemId: "name"`
 * is for the expense vendor field, which resolves server-side by name or
 * Vendor alias through `findOrCreateVendor` (see the doc on
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
  thumb: vendorThumb(vendor),
  ...(vendor.count != null && {
    presentation: {
      trailing: [
        {
          text: `${vendor.count} ${vendor.count === 1 ? "purchase" : "purchases"}`,
          node: formatCount(vendor.count),
        },
      ],
    },
  }),
});
