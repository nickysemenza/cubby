import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import type {
  LocationShortcode,
  ProductShortcode,
  ShortcodeFor,
} from "@cubby/schemas/identifiers";
import { infLocation } from "@cubby/schemas/location";
import { productTopLevelOut } from "@cubby/schemas/product";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { lazy, Suspense } from "react";
import type { z } from "zod";

import { useUpcAwareCreate } from "~/app/_components/products/use-upc-aware-create";
import { location } from "~/app/locations/location.functions";
import { product } from "~/app/products/product.functions";
import { captureRequest } from "~/entities/editing/editor-requests";
import {
  entityListFor,
  type EntityListParams,
} from "~/entities/entity-list.functions";

import {
  buildLocationComboboxItem,
  buildLocationComboboxItemFromDetail,
  buildProductComboboxItem,
  buildRecordComboboxItem,
  buildSearchHitComboboxItem,
  pickerRecord,
  type PickerRecord,
  type ProductPickerIntent,
} from "./combobox-builders";
import type { ComboboxItem } from "./combobox-types";
import {
  pagination,
  resolveBlankFilterKey,
  useEntitySearchRows,
  type EntitySearchScope,
  type CreatedResultParser,
  type PickerSearchEntity,
  type UseEntitySearchConfig,
} from "./entity-search-hooks";

const EntityEditDialog = lazy(() =>
  import("~/entities/editing/entity-edit-dialog").then((module) => ({
    default: module.EntityEditDialog,
  })),
);

/** What a picker search source hands its combobox. */
export interface EntitySearchResult<TId extends string> {
  items: ComboboxItem<TId>[];
  onSearchChange: (query: string) => void;
  isLoading: boolean;
  onCreateNew?: (name: string) => Promise<ComboboxItem<TId>>;
  // Wire this to the combobox's open/close so the options query stays
  // deferred until the user actually opens the picker (off the page's
  // critical path).
  onOpenChange: (open: boolean) => void;
}

export interface WithEntitySearchProps<TId extends string = string> {
  /** Candidate filters derived from the owning editor's dependent fields. */
  scope?: EntitySearchScope | null;
  /**
   * Bivariant on purpose (the `bivarianceHack` idiom): manifest-driven
   * callers hand a string-keyed provider to a branded-id picker without an
   * assertion on the branded identifier type.
   */
  children: {
    bivarianceHack(props: EntitySearchResult<TId>): ReactNode;
  }["bivarianceHack"];
}

/** Every non-vendor picker entity writes its own branded shortcode. */
export type EntitySearchEntity = Exclude<PickerSearchEntity, "vendor">;

const detailPlaceholder = (entity: PickerSearchEntity) =>
  `${entityInspectorMetadata[entity].shortcodePrefix}2222`;

function parseCreated<T>(schema: z.ZodType<T>): CreatedResultParser<T> {
  return (result: unknown) => schema.safeParse(result).data;
}

// --- create-from-picker resolution (hook-shaped: `useEntitySearchRows`
// calls it unconditionally through the config). ---

function useDialogCreateNew<TId extends string>(
  openDialog: (name: string) => Promise<ComboboxItem<TId>>,
) {
  return openDialog;
}

function useNoCreateNew() {
  return undefined;
}

/** A pasted/typed UPC skips the name-only dialog via the UPC lookup cascade. */
function useProductCreateNew(
  openDialog: (name: string) => Promise<ComboboxItem<ProductShortcode>>,
) {
  return useUpcAwareCreate(openDialog);
}

type ManifestPickerEntity = Exclude<EntitySearchEntity, "location" | "product">;

/**
 * A list-backed picker's filters: the entity's own manifest name filter, any
 * dependent-field scope, and — for ledger parties — household members only.
 * Plantings have no name filter, so their candidates come only from scope.
 */
function pickerListFilters(
  entity: ManifestPickerEntity,
  searchQuery: string,
  scope: EntitySearchScope | null | undefined,
): EntitySearchScope {
  const own: [string, string | readonly string[]][] = [];
  if (entity === "ledgerParty") own.push(["kind", ["member"]]);
  if (entity !== "planting")
    own.push([resolveBlankFilterKey(entity), searchQuery]);
  return Object.fromEntries([...own, ...Object.entries(scope ?? {})]);
}

/** The one list-backed row source: `entityListFor(entity)` + `pickerListFilters`. */
function manifestListSource<E extends ManifestPickerEntity>(entity: E) {
  return function useManifestListSource(
    searchQuery: string,
    enabled: boolean,
    scope?: EntitySearchScope | null,
  ) {
    const { data, isLoading } = useQuery({
      ...entityListFor(entity).queryOptions(
        // SAFETY: every filter key comes from this entity's manifest filter
        // descriptors or its declared dependent-field scope; the route parser
        // validates the input again.
        {
          filters: pickerListFilters(entity, searchQuery, scope),
          pagination,
        } as EntityListParams<E>,
      ),
      enabled,
    });
    return {
      data: data?.items.map((item) => pickerRecord.parse(item)),
      isLoading,
    };
  };
}

function manifestConfig<E extends ManifestPickerEntity>(
  entity: E,
  create: "dialog" | "none" = "none",
): UseEntitySearchConfig<ShortcodeFor<E>, PickerRecord, PickerRecord> {
  const build = (row: PickerRecord) => buildRecordComboboxItem(entity, row);
  return {
    detailPlaceholder: detailPlaceholder(entity),
    splitBlankTyped: true,
    supportsGlobalSearch: entityInspectorMetadata[entity].searchable,
    useListSource: manifestListSource(entity),
    build,
    buildDetail: build,
    // SAFETY: only queried when `supportsGlobalSearch` (the manifest's
    // `searchable` trait) holds, so `entity` is a `SearchableEntity` here.
    buildSearchHit: (hit) =>
      buildSearchHitComboboxItem(hit, entity as never) as never,
    useOnCreateNew: create === "dialog" ? useDialogCreateNew : useNoCreateNew,
    createNew: create,
    parseCreatedResult: parseCreated(pickerRecord),
  };
}

/**
 * `location.search` (not `.list`): the picker needs {id, name, type,
 * ancestors, coverImage}, so it skips the inventory-entry + product relation
 * joins and the batched product-pricing pass that `.list` pays for on every
 * keystroke.
 */
function useLocationListSource(searchQuery: string, enabled: boolean) {
  const { data, isLoading } = useQuery({
    ...location.search.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
      // Explicit: the list factory's default direction is `desc` (right for a
      // `createdAt` table, backwards for a name-ordered typeahead).
      sort: { orderBy: "name", direction: "asc" },
    }),
    enabled,
  });
  return { data: data?.data, isLoading };
}

/**
 * `product.search` (not `.list`) returns the compact picker shape plus its
 * batched quantity evidence, without paying for the full product graph. Used
 * for both the blank and the typed query — `splitBlankTyped: false` below.
 */
function useProductListSource(searchQuery: string, enabled: boolean) {
  const { data, isLoading } = useQuery({
    ...product.search.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
    enabled,
  });
  return { data: data?.items, isLoading };
}

const locationConfig: UseEntitySearchConfig<
  LocationShortcode,
  Parameters<typeof buildLocationComboboxItem>[0],
  Parameters<typeof buildLocationComboboxItemFromDetail>[0]
> = {
  detailPlaceholder: detailPlaceholder("location"),
  splitBlankTyped: true,
  useListSource: useLocationListSource,
  build: buildLocationComboboxItem,
  buildDetail: buildLocationComboboxItemFromDetail,
  buildSearchHit: (hit) => buildSearchHitComboboxItem(hit, "location"),
  useOnCreateNew: useDialogCreateNew,
  createNew: "dialog",
  parseCreatedResult: parseCreated(infLocation),
};

function productConfig(
  intent: ProductPickerIntent,
): UseEntitySearchConfig<
  ProductShortcode,
  Parameters<typeof buildProductComboboxItem>[0],
  Parameters<typeof buildProductComboboxItem>[0]
> {
  const build = (item: Parameters<typeof buildProductComboboxItem>[0]) =>
    buildProductComboboxItem(item, intent);
  return {
    detailPlaceholder: detailPlaceholder("product"),
    splitBlankTyped: false,
    useListSource: useProductListSource,
    build,
    buildDetail: build,
    // Never queried (`splitBlankTyped: false`), but the config needs a value.
    buildSearchHit: (hit) => buildSearchHitComboboxItem(hit, "product"),
    useOnCreateNew: useProductCreateNew,
    createNew: "dialog",
    parseCreatedResult: parseCreated(productTopLevelOut),
  };
}

const manifestConfigs = {
  ingredient: manifestConfig("ingredient", "dialog"),
  ledgerParty: manifestConfig("ledgerParty"),
  recipe: manifestConfig("recipe"),
  project: manifestConfig("project"),
  task: manifestConfig("task"),
  plant: manifestConfig("plant"),
  planting: manifestConfig("planting"),
  financialAccount: manifestConfig("financialAccount"),
  purchase: manifestConfig("purchase"),
} satisfies {
  [K in ManifestPickerEntity]: UseEntitySearchConfig<
    ShortcodeFor<K>,
    PickerRecord,
    PickerRecord
  >;
};

const productConfigs = {
  reference: productConfig("reference"),
  stock: productConfig("stock"),
};

function pickerConfig<E extends EntitySearchEntity>(
  entity: E,
  intent: ProductPickerIntent,
): UseEntitySearchConfig<ShortcodeFor<E>, never, never> {
  // SAFETY: each config is selected by the same entity key its builders and
  // row sources were declared for, so its item id is `ShortcodeFor<E>`; rows
  // flow only between that config's own source and builders.
  const config =
    entity === "product"
      ? productConfigs[intent]
      : entity === "location"
        ? locationConfig
        : manifestConfigs[entity as ManifestPickerEntity];
  // SAFETY: see above — `config` belongs to `entity`'s own id and rows.
  return config as never;
}

const dialogCreateEntities = new Set(["ingredient", "location", "product"]);

/**
 * The one entity combobox source: search-query state, the deferred-open gate,
 * the exact-shortcode lookup, the blank/typed row queries and, for
 * ingredient/location/product, the create-from-picker dialog (`dialog`,
 * which the caller renders beside its combobox). `intent` only matters for
 * product (reference vs. stock-inventory presentation).
 */
export function useEntityListSource<E extends EntitySearchEntity>(
  entity: E,
  {
    intent = "reference",
    scope,
  }: { intent?: ProductPickerIntent; scope?: EntitySearchScope | null } = {},
): EntitySearchResult<ShortcodeFor<E>> & { dialog: ReactNode } {
  const config = pickerConfig(entity, intent);
  const {
    items,
    isLoading,
    onSearchChange,
    onOpenChange,
    onCreateNew,
    isDialogOpen,
    setIsDialogOpen,
    pendingName,
    resolveWithEntity,
  } = useEntitySearchRows(entity, config, scope);
  const dialog =
    isDialogOpen && dialogCreateEntities.has(entity) ? (
      <Suspense fallback={null}>
        <EntityEditDialog
          open
          onOpenChange={setIsDialogOpen}
          // SAFETY: gated on `dialogCreateEntities`, the three editable
          // entities whose configs declare `createNew: "dialog"`.
          request={captureRequest(entity as "ingredient", {
            name: pendingName,
          })}
          onSuccess={(result) => {
            const parsed = config.parseCreatedResult?.(result);
            if (parsed !== undefined)
              resolveWithEntity(config.buildDetail(parsed));
          }}
        />
      </Suspense>
    ) : null;
  return {
    items,
    isLoading,
    onSearchChange,
    onOpenChange,
    onCreateNew,
    dialog,
  };
}

/** Render-prop form of `useEntityListSource`, for `SearchProvider` slots and
 * pickers rendered inside loops. */
export function WithEntitySearch<E extends EntitySearchEntity>({
  entity,
  intent,
  scope,
  children,
}: {
  entity: E;
  intent?: ProductPickerIntent;
} & WithEntitySearchProps<ShortcodeFor<E>>): ReactNode {
  const { dialog, ...search } = useEntityListSource(entity, { intent, scope });
  return (
    <>
      {dialog}
      {children(search)}
    </>
  );
}
