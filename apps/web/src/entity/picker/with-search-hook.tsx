import { entityRoster } from "@cubby/schemas/entity-roster";
import type {
  LocationShortcode,
  ProductShortcode,
  ShortcodeFor,
} from "@cubby/schemas/identifiers";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { z } from "zod";

import { captureRequest } from "~/entity/editing/editor-requests";
import { EntityEditDialog } from "~/entity/editing/entity-edit-dialog";
import { entityListFor, type EntityListParams } from "~/entity/entity-list";
import { featureRegistry } from "~/entity/feature-registry";
import { useEntityMetadata } from "~/entity/metadata";
import { location } from "~/integrations/tanstack-query/generated/domains/location.gen";
import { product } from "~/integrations/tanstack-query/generated/domains/product.gen";

import type { ComboboxItem } from "../../ui/combobox/combobox-types";
import {
  buildLocationComboboxItem,
  buildLocationComboboxItemFromDetail,
  buildPickerDetailItem,
  buildProductComboboxItem,
  buildRecordComboboxItem,
  buildSearchHitComboboxItem,
  pickerRecord,
  type PickerRecord,
  type ProductPickerIntent,
} from "./combobox-builders";
import {
  pagination,
  pickerQueryState,
  resolveBlankFilterKey,
  useEntitySearchRows,
  type EntitySearchScope,
  type PickerSearchEntity,
  type UseEntitySearchConfig,
} from "./entity-search-hooks";

/** What a picker search source hands its combobox. */
export interface EntitySearchResult<TId extends string> {
  items: ComboboxItem<TId>[];
  onSearchChange: (query: string) => void;
  isLoading: boolean;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  error?: string | null;
  onRetry?: () => void;
  onCreateNew?: (name: string) => Promise<ComboboxItem<TId>>;
  // Wire this to the combobox's open/close so the options query stays
  // deferred until the user actually opens the picker (off the page's
  // critical path).
  onOpenChange: (open: boolean) => void;
}

/**
 * The render-prop contract every "search provider" component in this codebase
 * implements — `referenceEntitySearch`'s per-entity providers, the vendor
 * providers in `with-vendor-search.tsx`, and any inline `SearchProvider` a
 * caller builds by hand around `useEntityListSource`. Kept independent of
 * `useEntityListSource` itself so those components can wrap it directly
 * rather than through a shared `<WithEntitySearch>` component.
 */
export interface SearchProviderProps<TId extends string = string> {
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
  `${entityRoster[entity].shortcodePrefix}2222`;

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
  const { useUpcAwareCreate } = featureRegistry().components;
  return useUpcAwareCreate(openDialog);
}

type ManifestPickerEntity = Exclude<EntitySearchEntity, "location" | "product">;

/**
 * A list-backed picker's filters: the entity's own manifest name filter, any
 * dependent-field scope, and — for ledger parties — household members only.
 * Plantings have no name filter, so their candidates come only from scope.
 */
function pickerListFilters(
  queryClient: QueryClient,
  entity: ManifestPickerEntity,
  searchQuery: string,
  scope: EntitySearchScope | null | undefined,
): EntitySearchScope {
  const own: [string, string | readonly string[]][] = [];
  if (entity === "ledgerParty") own.push(["kind", ["member"]]);
  // Plantings are found by scope (location, date), never by a typed name.
  const nameKey =
    entity === "planting" ? null : resolveBlankFilterKey(queryClient, entity);
  if (nameKey) own.push([nameKey, searchQuery]);
  return Object.fromEntries([...own, ...Object.entries(scope ?? {})]);
}

/** The one list-backed row source: `entityListFor(entity)` + `pickerListFilters`. */
function manifestListSource<E extends ManifestPickerEntity>(entity: E) {
  return function useManifestListSource(
    searchQuery: string,
    enabled: boolean,
    scope?: EntitySearchScope | null,
  ) {
    const queryClient = useQueryClient();
    useEntityMetadata(entity);
    const query = useInfiniteQuery({
      ...entityListFor(entity).infiniteQueryOptions(
        // SAFETY: every filter key comes from this entity's manifest filter
        // descriptors or its declared dependent-field scope; the route parser
        // validates the input again.
        {
          filters: pickerListFilters(queryClient, entity, searchQuery, scope),
          pagination,
        } as EntityListParams<E>,
      ),
      enabled,
    });
    return {
      data: query.data?.pages.flatMap((page) =>
        page.items.map((item) => pickerRecord.parse(item)),
      ),
      ...pickerQueryState(query),
    };
  };
}

function manifestConfig<E extends ManifestPickerEntity>(
  queryClient: QueryClient,
  entity: E,
  create: "dialog" | "none" = "none",
): UseEntitySearchConfig<ShortcodeFor<E>, PickerRecord, PickerRecord> {
  const build = (row: PickerRecord) =>
    buildRecordComboboxItem(queryClient, entity, row);
  return {
    detailPlaceholder: detailPlaceholder(entity),
    splitBlankTyped: true,
    supportsGlobalSearch: entityRoster[entity].searchable,
    useListSource: manifestListSource(entity),
    build,
    buildDetail: (detail) => buildPickerDetailItem(queryClient, entity, detail),
    // SAFETY: only queried when `supportsGlobalSearch` (the manifest's
    // `searchable` trait) holds, so `entity` is a `SearchableEntity` here.
    buildSearchHit: (hit) =>
      buildSearchHitComboboxItem(hit, entity as never) as never,
    useOnCreateNew: create === "dialog" ? useDialogCreateNew : useNoCreateNew,
    createNew: create,
  };
}

/**
 * `location.search` (not `.list`): the picker needs {id, name, type,
 * ancestors, coverImage}, so it skips the inventory-entry + product relation
 * joins and the batched product-pricing pass that `.list` pays for on every
 * keystroke.
 */
function useLocationListSource(searchQuery: string, enabled: boolean) {
  const query = useInfiniteQuery({
    ...location.search.infiniteQueryOptions(
      {
        filters: { nameFilter: searchQuery },
        pagination,
        sort: { orderBy: "name", direction: "asc" },
      },
      {
        pageParamSchema: z.number().int().nonnegative(),
        initialPageParam: 0,
        page: (input, pageIndex) => ({
          ...input,
          pagination: { ...pagination, pageIndex },
        }),
        getNextPageParam: () => undefined,
      },
    ),
    getNextPageParam: (page, _pages, pageIndex) =>
      (pageIndex + 1) * pagination.pageSize < page.count
        ? pageIndex + 1
        : undefined,
    enabled,
  });
  return {
    data: query.data?.pages.flatMap((page) => page.data),
    ...pickerQueryState(query),
  };
}

/**
 * `product.search` (not `.list`) returns the compact picker shape plus its
 * batched quantity evidence, without paying for the full product graph. Used
 * for both the blank and the typed query — `splitBlankTyped: false` below.
 */
function useProductListSource(searchQuery: string, enabled: boolean) {
  const query = useInfiniteQuery({
    ...product.search.infiniteQueryOptions(
      { filters: { nameFilter: searchQuery }, pagination },
      {
        pageParamSchema: z.number().int().nonnegative(),
        initialPageParam: 0,
        page: (input, pageIndex) => ({
          ...input,
          pagination: { ...pagination, pageIndex },
        }),
        getNextPageParam: (page) =>
          page.meta.hasNextPage ? page.meta.pageIndex + 1 : undefined,
      },
    ),
    enabled,
  });
  return {
    data: query.data?.pages.flatMap((page) => page.items),
    ...pickerQueryState(query),
  };
}

const locationConfig = (
  queryClient: QueryClient,
): UseEntitySearchConfig<
  LocationShortcode,
  Parameters<typeof buildLocationComboboxItem>[0],
  Parameters<typeof buildLocationComboboxItemFromDetail>[0]
> => ({
  detailPlaceholder: detailPlaceholder("location"),
  splitBlankTyped: true,
  useListSource: useLocationListSource,
  build: buildLocationComboboxItem,
  buildDetail: (detail) =>
    buildPickerDetailItem(queryClient, "location", detail),
  buildSearchHit: (hit) => buildSearchHitComboboxItem(hit, "location"),
  useOnCreateNew: useDialogCreateNew,
  createNew: "dialog",
});

function productConfig(
  queryClient: QueryClient,
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
    buildDetail: (detail) =>
      buildPickerDetailItem(queryClient, "product", detail, intent),
    // Never queried (`splitBlankTyped: false`), but the config needs a value.
    buildSearchHit: (hit) => buildSearchHitComboboxItem(hit, "product"),
    useOnCreateNew: useProductCreateNew,
    createNew: "dialog",
  };
}

/** The editable entities a picker can create from a typed name. */
const dialogCreateEntities = new Set<string>([
  "ingredient",
  "location",
  "product",
]);

function pickerConfig<E extends EntitySearchEntity>(
  queryClient: QueryClient,
  entity: E,
  intent: ProductPickerIntent,
): UseEntitySearchConfig<ShortcodeFor<E>, never, never> {
  // SAFETY: each config is selected by the same entity key its builders and
  // row sources were declared for, so its item id is `ShortcodeFor<E>`; rows
  // flow only between that config's own source and builders.
  const config =
    entity === "product"
      ? productConfig(queryClient, intent)
      : entity === "location"
        ? locationConfig(queryClient)
        : manifestConfig(
            queryClient,
            entity as ManifestPickerEntity,
            dialogCreateEntities.has(entity) ? "dialog" : "none",
          );
  // SAFETY: see above — `config` belongs to `entity`'s own id and rows.
  return config as never;
}

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
  const queryClient = useQueryClient();
  useEntityMetadata(entity);
  const config = useMemo(
    () => pickerConfig(queryClient, entity, intent),
    [queryClient, entity, intent],
  );
  const {
    items,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    onLoadMore,
    error,
    onRetry,
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
      <EntityEditDialog
        open
        onOpenChange={setIsDialogOpen}
        // Gated on `dialogCreateEntities`, the three editable entities
        // whose configs declare `createNew: "dialog"`.
        request={captureRequest(entity as "ingredient", {
          name: pendingName,
        })}
        onSuccess={(result) => {
          // Save receipts contain the normalized identity/title, not the
          // detail graph. Resolve before the dialog closes its pending choice.
          resolveWithEntity(
            buildRecordComboboxItem(queryClient, entity, result),
          );
        }}
      />
    ) : null;
  return {
    items,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    onLoadMore,
    error,
    onRetry,
    onSearchChange,
    onOpenChange,
    onCreateNew,
    dialog,
  };
}
