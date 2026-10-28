import { locationFieldEnvelopeSchemas } from "@cubby/schemas/compiler/generated/entity-field-envelopes/location";
import { productFieldEnvelopeSchemas } from "@cubby/schemas/compiler/generated/entity-field-envelopes/product";
import { vendorFieldEnvelopeSchemas } from "@cubby/schemas/compiler/generated/entity-field-envelopes/vendor";
import { displayImagesField } from "@cubby/schemas/display-images";
import {
  fieldValueOf,
  fieldEnvelopeFor,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import {
  type LocationShortcode,
  parseShortcodeFor,
  type ProductShortcode,
  type ShortcodeFor,
  type VendorShortcode,
} from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import {
  publicImageUrl,
  preferredImageUrl,
} from "@cubby/schemas/image-summary";
import type { LocationTreeNode, LocationType } from "@cubby/schemas/location";
import { locationType } from "@cubby/schemas/location";
import type { ProductPickerItemOut } from "@cubby/schemas/product";
import type { ProductCategorySummary as ProductCategory } from "@cubby/schemas/product-category-fields";
import {
  isServiceProductFeature,
  productCategoryFeature,
} from "@cubby/schemas/product-category-fields";
import {
  classifyProductOnHand,
  type ProductPickerOnHandOut,
} from "@cubby/schemas/product-read-fields";
import type { SearchableEntity, SearchHit } from "@cubby/schemas/search";
import { type ShortcodeType } from "@cubby/shared";
import { type QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { RecordEmoji } from "~/entity/components/record-emoji";
import { VendorMark } from "~/entity/components/vendor-cell";
import { enumDisplayValue } from "~/entity/display/enum-field-display";
import { EntityIcon, entityLabel } from "~/entity/entities";
import { compactFieldText } from "~/entity/fields/field-text";
import type { EntityDetailByEntity } from "~/entity/generated/entity-details.gen";
import { entityMetadata } from "~/entity/metadata";
import { categoryText } from "~/entity/presentation/category-text";
import { locationToSegments } from "~/entity/presentation/location-breadcrumb";
import { LocationIcon } from "~/entity/presentation/location-icons";
import { resolveLocationPrimaryVisual } from "~/entity/presentation/location-visual-resolver";
import { matchKindLabel } from "~/entity/presentation/search-utils";
import { readPathValue } from "~/entity/read-path";
import { formatCount } from "~/lib/number-format";
import type {
  ComboboxItem,
  PickerChip,
  PickerThumb,
  PickerEntity,
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
/** `meta` facts the second line shows at most, so rows stay two lines. */
const MAX_META = 2;

/**
 * A record's row data from its manifest phone-row projection: the field in
 * the `subtitle` slot supplies the secondary/status column, `meta` fields
 * become the muted context line under the name, and `trailing` fields become
 * right-aligned chips. The same declaration drives the phone list row and
 * native, so a picker row says what the record's card says.
 */
function recordRowProjection<E extends ShortcodeType>(
  queryClient: QueryClient,
  entity: E,
  record: PickerRecord,
) {
  const titleField = entityMetadata(queryClient, entity).summary.titleField;
  const slotted = entityMetadata(queryClient, entity)
    .fields.fields.flatMap((field) => {
      const mobile = field.display.mobile;
      if (!mobile || field.key === titleField) return [];
      return [{ field, slot: mobile.slot, priority: mobile.priority ?? 50 }];
    })
    .sort((a, b) => a.priority - b.priority);
  const text = (entry: (typeof slotted)[number]) =>
    compactFieldText(queryClient, entity, record, entry.field);
  const subtitle = slotted
    .filter((entry) => entry.slot === "subtitle")
    .find((entry) => !!text(entry));
  const secondary = subtitle ? text(subtitle) : null;
  const rawSubtitle = subtitle
    ? readPathValue(
        record,
        subtitle.field.display.readPath ??
          subtitle.field.readKey ??
          subtitle.field.key,
      )
    : undefined;
  const status =
    subtitle?.field.kind === "enum" && typeof rawSubtitle === "string"
      ? enumDisplayValue(queryClient, entity, subtitle.field, rawSubtitle)
      : null;
  const trailing = slotted
    .filter((entry) => entry.slot === "trailing")
    .flatMap((entry): PickerChip[] => {
      const value = text(entry);
      return value ? [{ text: value }] : [];
    })
    .slice(0, MAX_TRAILING);
  const detail = slotted
    .filter((entry) => entry.slot === "meta")
    .flatMap((entry) => text(entry) ?? [])
    .slice(0, MAX_META)
    .join(" · ");
  return {
    ...(secondary && !status && { secondary }),
    ...(detail && { detail }),
    ...(status && { status: { text: status.label, color: status.color } }),
    trailing,
  };
}

/** `displayImages[0]` is the server-resolved cover for every entity that
 * declares images; the record's emoji (or entity glyph) stands in otherwise. */
function recordThumb(entity: ShortcodeType, record: PickerRecord): PickerThumb {
  const envelope = fieldEnvelopeFor(record, "displayImages");
  const cover = envelope
    ? displayImagesField.nullable().parse(fieldValueOf(envelope))?.[0]
    : undefined;
  return {
    imageUrl: cover ? preferredImageUrl(cover) : null,
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
 * projection supplies the secondary/status and trailing columns.
 */
export function buildRecordComboboxItem<E extends ShortcodeType>(
  queryClient: QueryClient,
  entity: E,
  record: PickerRecord,
): ComboboxItem<ShortcodeFor<E>> {
  const shortcode = parseShortcodeFor(entity, record.id);
  const title = record[entityMetadata(queryClient, entity).summary.titleField];
  const aliases = pickerAliases.safeParse(record.aliases).data;
  const { secondary, detail, status, trailing } = recordRowProjection(
    queryClient,
    entity,
    record,
  );
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
    ...(detail && { detail }),
    ...((status || trailing.length > 0) && {
      presentation: { status, trailing },
    }),
  };
}

/** Maps compact indexed-search hits into the picker contract. */
export function buildSearchHitComboboxItem<E extends SearchableEntity>(
  hit: SearchHit,
  entity: E,
): ComboboxItem<ShortcodeFor<E>> {
  const shortcode = parseShortcodeFor(entity, hit.id);
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
    secondary:
      hit.facts.join(" · ") || hit.subtitle || hit.typeHint || undefined,
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
      <EntityIcon entity={entity} size={14} />
    ),
  };
}

// Builders take minimal structural shapes (not the full *Out types) so both
// picker results and list-row relation summaries pass without casts.
export const buildProductComboboxItem = (
  product: {
    id: ProductShortcode;
    name: string;
    brandName?: string | null;
    fields?: Record<string, ReadableFieldEnvelope>;
    category?: ProductCategory | null;
    coverImageUrl?: string | null;
    aliases?: string[] | null;
    quantityLedger?: ProductPickerItemOut["quantityLedger"];
    onHand?: ProductPickerItemOut["onHand"];
    onHandUnits?: number | null;
    inventoryEntry?: readonly Pick<
      EntityDetailByEntity["product"]["inventoryEntry"][number],
      "id"
    >[];
  },
  intent: ProductPickerIntent = "reference",
): ComboboxItem<ProductShortcode> => {
  const ledger = product.quantityLedger;
  const onHandEnvelope = fieldEnvelopeFor(product, "onHandUnits");
  const currentUnits = onHandEnvelope
    ? fieldValueOf(onHandEnvelope)
    : product.onHandUnits;
  const units =
    currentUnits === undefined
      ? undefined
      : z.number().nullable().parse(currentUnits);
  // NULL means absent or incomparable stock. The canonical live inventory roster
  // distinguishes those states; quantity conversion and totals remain server-owned.
  const onHand: ProductPickerInput["onHand"] =
    product.onHand ??
    (units === undefined
      ? undefined
      : units !== null
        ? { state: "counted", units }
        : product.inventoryEntry === undefined || !ledger
          ? undefined
          : classifyProductOnHand({
              units,
              inventoryCount: product.inventoryEntry.length,
              locationCount: ledger.locationCount,
            }));
  const coverEnvelope = fieldEnvelopeFor(product, "displayImages");
  const cover = coverEnvelope
    ? displayImagesField.nullable().parse(fieldValueOf(coverEnvelope))?.[0]
    : undefined;
  const coverImageUrl = Object.hasOwn(product.fields ?? {}, "displayImages")
    ? cover
      ? preferredImageUrl(cover)
      : null
    : (product.coverImageUrl ?? null);
  const base = productPickerBase(product, coverImageUrl);
  const feature = fieldEnvelopeFor(product, "categoryFeature");
  return isServiceProductFeature(
    feature
      ? productCategoryFeature.nullable().parse(fieldValueOf(feature))
      : null,
  ) ||
    !ledger ||
    !onHand ||
    onHand.state === "unavailable"
    ? base
    : withProductInventoryPresentation(base, ledger, onHand, intent);
};

type ProductPickerInput = Parameters<typeof buildProductComboboxItem>[0];

function productPickerBase(
  product: ProductPickerInput,
  coverImageUrl: string | null,
): ComboboxItem<ProductShortcode> {
  const brand = fieldEnvelopeFor(product, "brandName");
  const secondary = [
    brand
      ? z.string().nullable().parse(fieldValueOf(brand))
      : product.brandName,
    product.category ? categoryText(product.category) : null,
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
      fallback: <EntityIcon entity="product" size={14} />,
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
  onHand: ProductPickerOnHandOut,
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
  type?: LocationType | null;
  fields?: Record<string, ReadableFieldEnvelope>;
  aliases?: string[] | null;
  ancestors?: Array<{ id?: string; name: string }> | null;
  coverImage?: Pick<ImageOut, "fields"> | null;
  coverImageUrl?: string | null;
}): ComboboxItem<LocationShortcode> => {
  const type = fieldEnvelopeFor(location, "type");
  const currentType = type
    ? locationType.nullable().parse(fieldValueOf(type))
    : (location.type ?? null);
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
    secondary: currentType ?? undefined,
    thumb: {
      imageUrl: location.coverImage
        ? (publicImageUrl(location.coverImage) ?? null)
        : (location.coverImageUrl ?? null),
      fallback: (
        <LocationIcon
          type={currentType}
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
  location: LocationTreeNode,
): ComboboxItem<LocationShortcode> =>
  buildLocationComboboxItem({
    id: location.id,
    name: location.name,
    aliases: location.aliases,
    fields: { type: location.fields.type },
    // `locationToSegments` is root→leaf and includes the location itself.
    ancestors: locationToSegments(location).slice(0, -1),
    coverImageUrl: resolveLocationPrimaryVisual(location).image?.url ?? null,
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

/** Normalize canonical public image fields once for both vendor picker identities. */
export const vendorPickerInputFromDetail = (
  detail: unknown,
): VendorPickerInput => {
  const vendor = vendorFieldEnvelopeSchemas.detail.parse(detail);
  const logoUrl = vendor.logo ? publicImageUrl(vendor.logo) : undefined;
  return {
    id: vendor.id,
    name: vendor.name,
    logo: logoUrl ? { url: logoUrl } : null,
  };
};

/** Detail projections shared by exact-code lookup and stored-selection hydration. */
type PickerDetailBuilder = (
  detail: PickerRecord,
  intent: ProductPickerIntent,
) => ComboboxItem;
const pickerDetailBuilders = new Map<PickerEntity, PickerDetailBuilder>([
  [
    "product",
    (detail, intent) =>
      buildProductComboboxItem(
        productFieldEnvelopeSchemas.detail.parse(detail),
        intent,
      ),
  ],
  [
    "location",
    (detail) =>
      buildLocationComboboxItemFromDetail(
        locationFieldEnvelopeSchemas.detail.parse(detail),
      ),
  ],
  [
    "vendor",
    (detail) =>
      buildVendorComboboxItem(vendorPickerInputFromDetail(detail), {
        itemId: "shortcode",
      }),
  ],
]);

export function buildPickerDetailItem<E extends PickerEntity>(
  queryClient: QueryClient,
  entity: E,
  detail: unknown,
  intent: ProductPickerIntent = "reference",
): ComboboxItem<ShortcodeFor<E>> {
  const record = pickerRecord.parse(detail);
  const build = pickerDetailBuilders.get(entity);
  const item = build
    ? build(record, intent)
    : buildRecordComboboxItem(queryClient, entity, record);
  return { ...item, id: parseShortcodeFor(entity, item.id) };
}
