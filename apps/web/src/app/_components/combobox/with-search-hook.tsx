import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import type {
  IngredientShortcode,
  LedgerPartyShortcode,
  LocationShortcode,
  ProductShortcode,
  ProjectShortcode,
  RecipeShortcode,
  TaskShortcode,
  ShortcodeFor,
} from "@cubby/schemas/identifiers";
import { ingredientOut } from "@cubby/schemas/ingredient";
import type { LedgerPartyOut } from "@cubby/schemas/ledger-party";
import { infLocation } from "@cubby/schemas/location";
import { productTopLevelOut } from "@cubby/schemas/product";
import type { SearchHit } from "@cubby/schemas/search";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { lazy, Suspense } from "react";
import type { z } from "zod";

import { useUpcAwareCreate } from "~/app/_components/products/use-upc-aware-create";
import { location } from "~/app/locations/location.functions";
import { product } from "~/app/products/product.functions";
import { vendor } from "~/app/vendors/vendor.functions";
import { captureRequest } from "~/entities/editing/editor-requests";
import {
  entityListFor,
  type EntityListParams,
} from "~/entities/entity-list.functions";

import {
  buildIngredientComboboxItem,
  buildLocationComboboxItem,
  buildLocationComboboxItemFromDetail,
  buildPlantingComboboxItem,
  buildProductComboboxItem,
  buildProjectComboboxItem,
  buildRecipeComboboxItem,
  buildSearchHitComboboxItem,
  buildTaskComboboxItem,
  buildVendorComboboxItem,
  type ProductPickerIntent,
} from "./combobox-builders";
import type { ComboboxItem } from "./combobox-types";
import {
  pagination,
  resolveBlankFilterKey,
  useEntitySearchRows,
  type CreatedResultParser,
  type PickerSearchEntity,
  type UseEntitySearchConfig,
} from "./entity-search-hooks";

type PlantingShortcode = ShortcodeFor<"planting">;

const EntityEditDialog = lazy(() =>
  import("~/entities/editing/entity-edit-dialog").then((module) => ({
    default: module.EntityEditDialog,
  })),
);
const ProductCreateDialog = lazy(() =>
  import("~/app/_components/products/product-create-dialog").then((module) => ({
    default: module.ProductCreateDialog,
  })),
);

export interface WithEntitySearchProps<TId extends string = string> {
  /**
   * Bivariant on purpose (the `bivarianceHack` idiom): the shared dispatcher
   * narrows the entity at runtime and hands `children` to the matching
   * per-entity shell, which a contravariant callback type would only allow
   * through an assertion on a branded identifier type.
   */
  children: {
    bivarianceHack(props: {
      items: ComboboxItem<TId>[];
      onSearchChange: (query: string) => void;
      isLoading: boolean;
      onCreateNew?: (name: string) => Promise<ComboboxItem<TId>>;
      // Wire this to the combobox's open/close so the options query stays
      // deferred until the user actually opens the picker (off the page's
      // critical path).
      onOpenChange: (open: boolean) => void;
    }): ReactNode;
  }["bivarianceHack"];
}

const detailPlaceholder = (entity: PickerSearchEntity) =>
  `${entityInspectorMetadata[entity].shortcodePrefix}2222`;

function parseCreated<T>(schema: z.ZodType<T>): CreatedResultParser<T> {
  return (result: unknown) => {
    const parsed = schema.safeParse(result);
    return parsed.success ? parsed.data : undefined;
  };
}

// --- Blank-query row sources (hook-shaped: each runs its own `useQuery`
// unconditionally, so selecting between them by object lookup in
// `useEntitySearchRows` never puts a hook call inside a branch). ---

const ingredientBlankFilterKey = resolveBlankFilterKey("ingredient");
function useIngredientListSource(searchQuery: string, enabled: boolean) {
  const { data, isLoading } = useQuery({
    ...entityListFor("ingredient").queryOptions({
      // SAFETY: `ingredientBlankFilterKey` is resolved from ingredient's own
      // `name`-column filter descriptor (`resolveBlankFilterKey`), so this
      // object always has exactly the one key ingredient's filters expect.
      filters: {
        [ingredientBlankFilterKey]: searchQuery,
      } as EntityListParams<"ingredient">["filters"],
      pagination,
    }),
    enabled,
  });
  return { data: data?.items, isLoading };
}

function useLedgerPartyListSource(searchQuery: string, enabled: boolean) {
  const { data, isLoading } = useQuery({
    ...entityListFor("ledgerParty").queryOptions({
      filters: {
        search: searchQuery,
        kind: ["member"],
      },
      pagination,
    }),
    enabled,
  });
  return { data: data?.items, isLoading };
}

const recipeBlankFilterKey = resolveBlankFilterKey("recipe");
function useRecipeListSource(searchQuery: string, enabled: boolean) {
  const { data, isLoading } = useQuery({
    ...entityListFor("recipe").queryOptions({
      // SAFETY: see `useIngredientListSource` — same manifest-resolved key.
      filters: {
        [recipeBlankFilterKey]: searchQuery,
      } as EntityListParams<"recipe">["filters"],
      pagination,
    }),
    enabled,
  });
  return { data: data?.items, isLoading };
}

const projectBlankFilterKey = resolveBlankFilterKey("project");
function useProjectListSource(searchQuery: string, enabled: boolean) {
  const { data, isLoading } = useQuery({
    ...entityListFor("project").queryOptions({
      // SAFETY: see `useIngredientListSource` — same manifest-resolved key.
      filters: {
        [projectBlankFilterKey]: searchQuery,
      } as EntityListParams<"project">["filters"],
      pagination,
    }),
    enabled,
  });
  return { data: data?.items, isLoading };
}

const taskBlankFilterKey = resolveBlankFilterKey("task");
function useTaskListSource(searchQuery: string, enabled: boolean) {
  const { data, isLoading } = useQuery({
    ...entityListFor("task").queryOptions({
      // SAFETY: see `useIngredientListSource` — same manifest-resolved key.
      filters: {
        [taskBlankFilterKey]: searchQuery,
      } as EntityListParams<"task">["filters"],
      pagination,
    }),
    enabled,
  });
  return { data: data?.items, isLoading };
}

const plantingBlankFilterKey = resolveBlankFilterKey("planting");
function usePlantingListSource(searchQuery: string, enabled: boolean) {
  const { data, isLoading } = useQuery({
    ...entityListFor("planting").queryOptions({
      // SAFETY: `plantingBlankFilterKey` is resolved from planting's own
      // `displayName` filter descriptor, so this object has exactly the key
      // the planting list accepts for a blank or typed picker query.
      filters: {
        [plantingBlankFilterKey]: searchQuery,
      } as EntityListParams<"planting">["filters"],
      pagination,
    }),
    enabled,
  });
  return { data: data?.items, isLoading };
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
      // `createdAt` table, backwards for a name-ordered typeahead — it opened
      // on "zipties & pads").
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

// --- create-from-picker resolution (hook-shaped for the same reason). ---

function useDialogCreateNew<TId extends string>(
  openDialog: (name: string) => Promise<ComboboxItem<TId>>,
) {
  return openDialog;
}

function useNoCreateNew() {
  return undefined;
}

function useProductCreateNew(
  openDialog: (name: string) => Promise<ComboboxItem<ProductShortcode>>,
) {
  // A pasted/typed UPC skips the name-only dialog and resolves via the UPC
  // lookup cascade instead; non-UPC input still opens the create dialog.
  return useUpcAwareCreate(openDialog);
}

const ingredientConfig: UseEntitySearchConfig<
  IngredientShortcode,
  Parameters<typeof buildIngredientComboboxItem>[0],
  Parameters<typeof buildIngredientComboboxItem>[0]
> = {
  detailPlaceholder: detailPlaceholder("ingredient"),
  splitBlankTyped: true,
  useListSource: useIngredientListSource,
  build: buildIngredientComboboxItem,
  buildDetail: buildIngredientComboboxItem,
  buildSearchHit: (hit) => buildSearchHitComboboxItem(hit, "ingredient"),
  useOnCreateNew: useDialogCreateNew,
  createNew: "dialog",
  parseCreatedResult: parseCreated(ingredientOut),
};

const buildLedgerPartyComboboxItem = (
  party: LedgerPartyOut,
): ComboboxItem<LedgerPartyShortcode> => ({
  id: party.id,
  shortcode: party.id,
  name: party.name,
});

const ledgerPartyConfig: UseEntitySearchConfig<
  LedgerPartyShortcode,
  LedgerPartyOut,
  LedgerPartyOut
> = {
  detailPlaceholder: detailPlaceholder("ledgerParty"),
  splitBlankTyped: false,
  supportsGlobalSearch: false,
  useListSource: useLedgerPartyListSource,
  build: buildLedgerPartyComboboxItem,
  buildDetail: buildLedgerPartyComboboxItem,
  buildSearchHit: () => {
    throw new Error("Ledger parties use their list search, not global search");
  },
  useOnCreateNew: useNoCreateNew,
  createNew: "none",
};

const recipeConfig: UseEntitySearchConfig<
  RecipeShortcode,
  Parameters<typeof buildRecipeComboboxItem>[0],
  Parameters<typeof buildRecipeComboboxItem>[0]
> = {
  detailPlaceholder: detailPlaceholder("recipe"),
  splitBlankTyped: true,
  useListSource: useRecipeListSource,
  build: buildRecipeComboboxItem,
  buildDetail: buildRecipeComboboxItem,
  buildSearchHit: (hit) => buildSearchHitComboboxItem(hit, "recipe"),
  // For recipes, we don't provide the ability to create from this interface.
  useOnCreateNew: useNoCreateNew,
  createNew: "none",
};

/**
 * Project search uses the normal searchable list so notes and locations can
 * match in addition to the name. No create-from-picker affordance.
 */
const projectConfig: UseEntitySearchConfig<
  ProjectShortcode,
  Parameters<typeof buildProjectComboboxItem>[0],
  Parameters<typeof buildProjectComboboxItem>[0]
> = {
  detailPlaceholder: detailPlaceholder("project"),
  splitBlankTyped: true,
  useListSource: useProjectListSource,
  build: buildProjectComboboxItem,
  buildDetail: buildProjectComboboxItem,
  buildSearchHit: (hit) => buildSearchHitComboboxItem(hit, "project"),
  useOnCreateNew: useNoCreateNew,
  createNew: "none",
};

/**
 * Server-searched task picker — `task.list` filtered by its `search` field.
 * No create-from-picker affordance.
 */
const taskConfig: UseEntitySearchConfig<
  TaskShortcode,
  Parameters<typeof buildTaskComboboxItem>[0],
  Parameters<typeof buildTaskComboboxItem>[0]
> = {
  detailPlaceholder: detailPlaceholder("task"),
  splitBlankTyped: true,
  useListSource: useTaskListSource,
  build: buildTaskComboboxItem,
  buildDetail: buildTaskComboboxItem,
  buildSearchHit: (hit) => buildSearchHitComboboxItem(hit, "task"),
  useOnCreateNew: useNoCreateNew,
  createNew: "none",
};

const plantingConfig: UseEntitySearchConfig<
  PlantingShortcode,
  Parameters<typeof buildPlantingComboboxItem>[0],
  Parameters<typeof buildPlantingComboboxItem>[0]
> = {
  detailPlaceholder: detailPlaceholder("planting"),
  splitBlankTyped: true,
  useListSource: usePlantingListSource,
  build: buildPlantingComboboxItem,
  buildDetail: buildPlantingComboboxItem,
  buildSearchHit: (hit) => buildSearchHitComboboxItem(hit, "planting"),
  useOnCreateNew: useNoCreateNew,
  createNew: "none",
};

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
    // Never actually queried (`splitBlankTyped: false`), but the config shape
    // still needs a value.
    buildSearchHit: (hit) => buildSearchHitComboboxItem(hit, "product"),
    useOnCreateNew: useProductCreateNew,
    createNew: "upcAware",
    parseCreatedResult: parseCreated(productTopLevelOut),
  };
}

/**
 * Renders the shared create dialog for the three entities that use it.
 * Takes `parseCreatedResult`/`buildDetail` directly (rather than a whole
 * `config`) so each concretely-typed caller feeds it concretely-typed
 * arguments — no generic config union to bridge with an unsafe cast.
 */
function EntitySearchCreateDialog<TId extends string, TDetail>({
  entity,
  parseCreatedResult,
  buildDetail,
  isDialogOpen,
  setIsDialogOpen,
  pendingName,
  resolveWithEntity,
}: {
  entity: "ingredient" | "location" | "product";
  parseCreatedResult?: CreatedResultParser<TDetail>;
  buildDetail: (row: TDetail) => ComboboxItem<TId>;
  isDialogOpen: boolean;
  setIsDialogOpen: (open: boolean) => void;
  pendingName: string;
  resolveWithEntity: (item: ComboboxItem<TId>) => void;
}) {
  if (!isDialogOpen) return null;
  const onSuccess = (result: unknown) => {
    const parsed = parseCreatedResult?.(result);
    if (parsed === undefined) return;
    resolveWithEntity(buildDetail(parsed));
  };
  if (entity === "product") {
    return (
      <Suspense fallback={null}>
        <ProductCreateDialog
          open
          onOpenChange={setIsDialogOpen}
          seed={{ name: pendingName }}
          onSuccess={onSuccess}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <EntityEditDialog
        open
        onOpenChange={setIsDialogOpen}
        request={captureRequest(entity, { name: pendingName })}
        onSuccess={onSuccess}
      />
    </Suspense>
  );
}

/** Row shape shared by every vendor query (list, typed search, and exact-code detail all resolve to it). */
type VendorRow = Parameters<typeof buildVendorComboboxItem>[0];

function useVendorListSource(_searchQuery: string, enabled: boolean) {
  const { data, isLoading } = useQuery({
    ...vendor.options.queryOptions(null),
    enabled,
  });
  return { data, isLoading };
}

/**
 * Vendor has no shared create dialog — a name that matches no roster row IS
 * the new vendor, minted by the save that follows (`findOrCreateVendor`) or,
 * for the persisted-relation picker, by `useEntityCommands("vendor")` up
 * front. Both call sites supply their own `onCreateNew`.
 */
function useCallerCreateNew<TId extends string>(
  _openDialog: (name: string) => Promise<ComboboxItem<TId>>,
  onCreateNew: ((name: string) => Promise<ComboboxItem<TId>>) | undefined,
) {
  return onCreateNew;
}

/**
 * One tiny concretely-typed wrapper per non-vendor entity. Each is only a
 * render-prop shell now — every query, the exact-code lookup, and the dialog
 * decision live in `useEntitySearchRows` + that entity's config object above.
 * Concrete (not generic over `entity`) so none of them need the unsound
 * union-to-generic cast a single shared component would require: TS already
 * knows `ingredientConfig`'s row/detail/id types line up with `children`'s.
 */
function IngredientEntitySearch({
  children,
}: WithEntitySearchProps<IngredientShortcode>) {
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
  } = useEntitySearchRows("ingredient", ingredientConfig);
  return (
    <>
      <EntitySearchCreateDialog
        entity="ingredient"
        parseCreatedResult={ingredientConfig.parseCreatedResult}
        buildDetail={ingredientConfig.buildDetail}
        isDialogOpen={isDialogOpen}
        setIsDialogOpen={setIsDialogOpen}
        pendingName={pendingName}
        resolveWithEntity={resolveWithEntity}
      />
      {children({
        items,
        onSearchChange,
        isLoading,
        onCreateNew,
        onOpenChange,
      })}
    </>
  );
}

function LocationEntitySearch({
  children,
}: WithEntitySearchProps<LocationShortcode>) {
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
  } = useEntitySearchRows("location", locationConfig);
  return (
    <>
      <EntitySearchCreateDialog
        entity="location"
        parseCreatedResult={locationConfig.parseCreatedResult}
        buildDetail={locationConfig.buildDetail}
        isDialogOpen={isDialogOpen}
        setIsDialogOpen={setIsDialogOpen}
        pendingName={pendingName}
        resolveWithEntity={resolveWithEntity}
      />
      {children({
        items,
        onSearchChange,
        isLoading,
        onCreateNew,
        onOpenChange,
      })}
    </>
  );
}

function ProductEntitySearch({
  intent = "reference",
  children,
}: WithEntitySearchProps<ProductShortcode> & { intent?: ProductPickerIntent }) {
  const config = productConfig(intent);
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
  } = useEntitySearchRows("product", config);
  return (
    <>
      <EntitySearchCreateDialog
        entity="product"
        parseCreatedResult={config.parseCreatedResult}
        buildDetail={config.buildDetail}
        isDialogOpen={isDialogOpen}
        setIsDialogOpen={setIsDialogOpen}
        pendingName={pendingName}
        resolveWithEntity={resolveWithEntity}
      />
      {children({
        items,
        onSearchChange,
        isLoading,
        onCreateNew,
        onOpenChange,
      })}
    </>
  );
}

/**
 * Recipe, project, and task have no create-from-picker affordance, so unlike
 * the three above they need no dialog at all.
 */
function RecipeEntitySearch({
  children,
}: WithEntitySearchProps<RecipeShortcode>) {
  const { items, isLoading, onSearchChange, onOpenChange } =
    useEntitySearchRows("recipe", recipeConfig);
  return <>{children({ items, onSearchChange, isLoading, onOpenChange })}</>;
}

function LedgerPartyEntitySearch({
  children,
}: WithEntitySearchProps<LedgerPartyShortcode>) {
  const { items, isLoading, onSearchChange, onOpenChange } =
    useEntitySearchRows("ledgerParty", ledgerPartyConfig);
  return <>{children({ items, onSearchChange, isLoading, onOpenChange })}</>;
}

function ProjectEntitySearch({
  children,
}: WithEntitySearchProps<ProjectShortcode>) {
  const { items, isLoading, onSearchChange, onOpenChange } =
    useEntitySearchRows("project", projectConfig);
  return <>{children({ items, onSearchChange, isLoading, onOpenChange })}</>;
}

function TaskEntitySearch({ children }: WithEntitySearchProps<TaskShortcode>) {
  const { items, isLoading, onSearchChange, onOpenChange } =
    useEntitySearchRows("task", taskConfig);
  return <>{children({ items, onSearchChange, isLoading, onOpenChange })}</>;
}

function PlantingEntitySearch({
  children,
}: WithEntitySearchProps<PlantingShortcode>) {
  const { items, isLoading, onSearchChange, onOpenChange } =
    useEntitySearchRows("planting", plantingConfig);
  return <>{children({ items, onSearchChange, isLoading, onOpenChange })}</>;
}

type NonVendorPickerEntity = Exclude<PickerSearchEntity, "vendor">;

// Typed over the UNION of picker ids: the public overloads keep each call
// site precise, and the bivariant `children` lets every per-entity shell
// accept the union-typed callback without asserting a branded id type.
function NonVendorEntitySearch({
  entity,
  intent,
  children,
}: {
  entity: NonVendorPickerEntity;
  intent?: ProductPickerIntent;
} & WithEntitySearchProps<EntityIdFor<NonVendorPickerEntity>>) {
  switch (entity) {
    case "ingredient":
      return <IngredientEntitySearch>{children}</IngredientEntitySearch>;
    case "ledgerParty":
      return <LedgerPartyEntitySearch>{children}</LedgerPartyEntitySearch>;
    case "location":
      return <LocationEntitySearch>{children}</LocationEntitySearch>;
    case "product":
      return (
        <ProductEntitySearch intent={intent}>{children}</ProductEntitySearch>
      );
    case "recipe":
      return <RecipeEntitySearch>{children}</RecipeEntitySearch>;
    case "project":
      return <ProjectEntitySearch>{children}</ProjectEntitySearch>;
    case "task":
      return <TaskEntitySearch>{children}</TaskEntitySearch>;
    case "planting":
      return <PlantingEntitySearch>{children}</PlantingEntitySearch>;
  }
}

function VendorEntitySearch<TId extends string>({
  build,
  buildSearchHit,
  onCreateNew,
  children,
}: {
  build: (row: VendorRow) => ComboboxItem<TId>;
  buildSearchHit: (hit: SearchHit) => ComboboxItem<TId>;
  onCreateNew?: (name: string) => Promise<ComboboxItem<TId>>;
} & WithEntitySearchProps<TId>) {
  const config: UseEntitySearchConfig<TId, VendorRow, VendorRow> = {
    detailPlaceholder: detailPlaceholder("vendor"),
    splitBlankTyped: true,
    useListSource: useVendorListSource,
    build,
    buildDetail: build,
    buildSearchHit,
    useOnCreateNew: (openDialog) => useCallerCreateNew(openDialog, onCreateNew),
    createNew: "none",
  };
  const {
    items,
    isLoading,
    onSearchChange,
    onOpenChange,
    onCreateNew: resolvedOnCreateNew,
  } = useEntitySearchRows("vendor", config);

  return (
    <>
      {children({
        items,
        onSearchChange,
        isLoading,
        onCreateNew: resolvedOnCreateNew,
        onOpenChange,
      })}
    </>
  );
}

/** Every non-vendor entity's item id is its own branded shortcode type. */
type EntityIdFor<E extends Exclude<PickerSearchEntity, "vendor">> =
  E extends "ingredient"
    ? IngredientShortcode
    : E extends "ledgerParty"
      ? LedgerPartyShortcode
      : E extends "location"
        ? LocationShortcode
        : E extends "product"
          ? ProductShortcode
          : E extends "recipe"
            ? RecipeShortcode
            : E extends "project"
              ? ProjectShortcode
              : E extends "task"
                ? TaskShortcode
                : PlantingShortcode;

/**
 * The shared entity combobox provider: search-query state, the deferred-open
 * gate, the exact-shortcode detail lookup, the blank/typed row queries, and
 * (for `createNew !== "none"`) the create-from-picker dialog — all wired from
 * one small per-entity config, so `entity` alone picks the right behavior.
 *
 * `intent` only matters for `entity="product"` (reference vs. stock-inventory
 * presentation). Vendor has no shared defaults at all — its item id is either
 * the vendor's name or its shortcode depending on the write path, so callers
 * supply `build`/`onCreateNew` directly.
 */
export function WithEntitySearch<
  E extends Exclude<PickerSearchEntity, "vendor">,
>(
  props: {
    entity: E;
    intent?: ProductPickerIntent;
  } & WithEntitySearchProps<EntityIdFor<E>>,
): ReactNode;
export function WithEntitySearch<TId extends string>(
  props: {
    entity: "vendor";
    build: (row: VendorRow) => ComboboxItem<TId>;
    buildSearchHit: (hit: SearchHit) => ComboboxItem<TId>;
    onCreateNew?: (name: string) => Promise<ComboboxItem<TId>>;
  } & WithEntitySearchProps<TId>,
): ReactNode;
export function WithEntitySearch<TId extends string>(
  props:
    | ({
        entity: Exclude<PickerSearchEntity, "vendor">;
        intent?: ProductPickerIntent;
      } & WithEntitySearchProps<
        EntityIdFor<Exclude<PickerSearchEntity, "vendor">>
      >)
    | ({
        entity: "vendor";
        build: (row: VendorRow) => ComboboxItem<TId>;
        buildSearchHit: (hit: SearchHit) => ComboboxItem<TId>;
        onCreateNew?: (name: string) => Promise<ComboboxItem<TId>>;
      } & WithEntitySearchProps<TId>),
): ReactNode {
  if (props.entity === "vendor") {
    return (
      <VendorEntitySearch
        build={props.build}
        buildSearchHit={props.buildSearchHit}
        onCreateNew={props.onCreateNew}
      >
        {props.children}
      </VendorEntitySearch>
    );
  }
  // `props.entity` here is the concrete non-vendor union (not a free generic),
  // so `props.children`'s type is exactly `NonVendorEntitySearch`'s expected
  // `WithEntitySearchProps<EntityIdFor<E>>["children"]` once `E` is inferred
  // from `entity` below — no cast needed to forward it.
  return (
    <NonVendorEntitySearch entity={props.entity} intent={props.intent}>
      {props.children}
    </NonVendorEntitySearch>
  );
}
