import type {
  IngredientShortcode,
  LocationShortcode,
  ProductShortcode,
  ProjectShortcode,
  RecipeShortcode,
  TaskShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { lazy, Suspense } from "react";
import { useUpcAwareCreate } from "~/app/_components/products/use-upc-aware-create";
import { location } from "~/app/locations/location.functions";
import { product } from "~/app/products/product.functions";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { entityListFor } from "~/entities/entity-list.functions";
import { search } from "~/lib/search.functions";
import {
  buildIngredientComboboxItem,
  buildLocationComboboxItem,
  buildLocationComboboxItemFromDetail,
  buildProductComboboxItem,
  buildProjectComboboxItem,
  buildRecipeComboboxItem,
  buildSearchHitComboboxItem,
  buildTaskComboboxItem,
  type ProductPickerIntent,
} from "./combobox-builders";
import type { ComboboxItem } from "./combobox-types";
import {
  pagination,
  useDeferredSearch,
  useEntitySearch,
  useEntitySearchWithDialog,
} from "./entity-search-hooks";

const EntityFormDialog = lazy(() =>
  import("~/entities/editing/entity-form-dialog").then((module) => ({
    default: module.EntityFormDialog,
  })),
);

export interface WithEntitySearchProps<TId extends string = string> {
  children: (props: {
    items: ComboboxItem<TId>[];
    onSearchChange: (query: string) => void;
    isLoading: boolean;
    onCreateNew?: (name: string) => Promise<ComboboxItem<TId>>;
    // Wire this to the combobox's open/close so the options query stays deferred
    // until the user actually opens the picker (off the page's critical path).
    onOpenChange: (open: boolean) => void;
  }) => ReactNode;
}

export function WithIngredientSearch({
  children,
}: WithEntitySearchProps<IngredientShortcode>) {
  const {
    searchQuery,
    onSearchChange,
    isDialogOpen,
    setIsDialogOpen,
    pendingName,
    openDialog,
    resolveWithEntity,
  } = useEntitySearchWithDialog<IngredientShortcode>();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const parsedCode = parseShortcode(searchQuery);
  const exactCode =
    parsedCode?.type === "ingredient" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...entityListFor("ingredient").queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() === "",
  });
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...search.find.queryOptions({
      query: searchQuery || "ingredient",
      entityTypes: ["ingredient"],
      limit: 20,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    entityDetailFor("ingredient").queryOptions(exactCode ?? "ING-2222", {
      enabled: exactCode != null,
    }),
  );

  return (
    <>
      {isDialogOpen && (
        <Suspense fallback={null}>
          <EntityFormDialog
            entity="ingredient"
            open
            onOpenChange={setIsDialogOpen}
            seed={{ name: pendingName }}
            onSuccess={(result) =>
              resolveWithEntity(
                buildIngredientComboboxItem(
                  result as Parameters<typeof buildIngredientComboboxItem>[0],
                ),
              )
            }
          />
        </Suspense>
      )}
      {children({
        items: searchingByCode
          ? exactItem
            ? [buildIngredientComboboxItem(exactItem)]
            : []
          : searchQuery.trim()
            ? (searchHits?.map((hit) =>
                buildSearchHitComboboxItem(hit, "ingredient"),
              ) ?? [])
            : (data?.items.map(buildIngredientComboboxItem) ?? []),
        onSearchChange,
        isLoading: exactCode
          ? isExactLoading
          : searchQuery.trim()
            ? isSearchLoading
            : isLoading,
        onCreateNew: openDialog,
        onOpenChange,
      })}
    </>
  );
}

export function WithLocationSearch({
  children,
}: WithEntitySearchProps<LocationShortcode>) {
  const {
    searchQuery,
    onSearchChange,
    isDialogOpen,
    setIsDialogOpen,
    pendingName,
    openDialog,
    resolveWithEntity,
  } = useEntitySearchWithDialog<LocationShortcode>();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  // `location.search` (not `.list`): the picker needs {id, name, type,
  // ancestors, coverImage}, so it skips the inventory-entry + product relation
  // joins and the batched product-pricing pass that `.list` pays for on every
  // keystroke.
  const parsedCode = parseShortcode(searchQuery);
  const exactCode =
    parsedCode?.type === "location" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...location.search.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
      // Explicit: the list factory's default direction is `desc` (right for a
      // `createdAt` table, backwards for a name-ordered typeahead — it opened
      // on "zipties & pads").
      sort: { orderBy: "name", direction: "asc" },
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() === "",
  });
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...search.find.queryOptions({
      query: searchQuery || "location",
      entityTypes: ["location"],
      limit: 20,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    entityDetailFor("location").queryOptions(exactCode ?? "LOC-2222", {
      enabled: exactCode != null,
    }),
  );

  return (
    <>
      {isDialogOpen && (
        <Suspense fallback={null}>
          <EntityFormDialog
            entity="location"
            open
            onOpenChange={setIsDialogOpen}
            seed={{ name: pendingName }}
            onSuccess={(result) =>
              resolveWithEntity(
                buildLocationComboboxItemFromDetail(
                  result as Parameters<
                    typeof buildLocationComboboxItemFromDetail
                  >[0],
                ),
              )
            }
          />
        </Suspense>
      )}
      {children({
        items: searchingByCode
          ? exactItem
            ? [buildLocationComboboxItemFromDetail(exactItem)]
            : []
          : searchQuery.trim()
            ? (searchHits?.map((hit) =>
                buildSearchHitComboboxItem(hit, "location"),
              ) ?? [])
            : (data?.items.map(buildLocationComboboxItem) ?? []),
        onSearchChange,
        isLoading: exactCode
          ? isExactLoading
          : searchQuery.trim()
            ? isSearchLoading
            : isLoading,
        onCreateNew: openDialog,
        onOpenChange,
      })}
    </>
  );
}

export function WithProductSearch({
  children,
  intent = "reference",
}: WithEntitySearchProps<ProductShortcode> & { intent?: ProductPickerIntent }) {
  const {
    searchQuery,
    onSearchChange,
    isDialogOpen,
    setIsDialogOpen,
    pendingName,
    openDialog,
    resolveWithEntity,
  } = useEntitySearchWithDialog<ProductShortcode>();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  // `product.search` (not `.list`) returns the compact picker shape plus its
  // batched quantity evidence, without paying for the full product graph.
  const parsedCode = parseShortcode(searchQuery);
  const exactCode =
    parsedCode?.type === "product" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...product.search.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
    enabled: enabled && !searchingByCode,
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    entityDetailFor("product").queryOptions(exactCode ?? "PRD-2222", {
      enabled: exactCode != null,
    }),
  );

  // A pasted/typed UPC skips the name-only dialog and resolves via the UPC
  // lookup cascade instead; non-UPC input still opens the create dialog.
  const onCreateNew = useUpcAwareCreate(openDialog);

  return (
    <>
      {isDialogOpen && (
        <Suspense fallback={null}>
          <EntityFormDialog
            entity="product"
            open
            onOpenChange={setIsDialogOpen}
            seed={{ name: pendingName }}
            onSuccess={(result) =>
              resolveWithEntity(
                buildProductComboboxItem(
                  result as Parameters<typeof buildProductComboboxItem>[0],
                ),
              )
            }
          />
        </Suspense>
      )}
      {children({
        items: searchingByCode
          ? exactItem
            ? [buildProductComboboxItem(exactItem, intent)]
            : []
          : (data?.items.map((item) =>
              buildProductComboboxItem(item, intent),
            ) ?? []),
        onSearchChange,
        isLoading: exactCode ? isExactLoading : isLoading,
        onCreateNew,
        onOpenChange,
      })}
    </>
  );
}

export function WithRecipeSearch({
  children,
}: WithEntitySearchProps<RecipeShortcode>) {
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const parsedCode = parseShortcode(searchQuery);
  const exactCode = parsedCode?.type === "recipe" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...entityListFor("recipe").queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() === "",
  });
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...search.find.queryOptions({
      query: searchQuery || "recipe",
      entityTypes: ["recipe"],
      limit: 20,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    entityDetailFor("recipe").queryOptions(exactCode ?? "RCP-2222", {
      enabled: exactCode != null,
    }),
  );

  // For recipes, we don't provide the ability to create from this interface
  return (
    <>
      {children({
        items: searchingByCode
          ? exactItem
            ? [buildRecipeComboboxItem(exactItem)]
            : []
          : searchQuery.trim()
            ? (searchHits?.map((hit) =>
                buildSearchHitComboboxItem(hit, "recipe"),
              ) ?? [])
            : (data?.items.map(buildRecipeComboboxItem) ?? []),
        onSearchChange,
        isLoading: exactCode
          ? isExactLoading
          : searchQuery.trim()
            ? isSearchLoading
            : isLoading,
        onOpenChange,
      })}
    </>
  );
}

/**
 * Project search uses the normal searchable list so notes and locations can
 * match in addition to the name. No create-from-picker affordance.
 */
export function WithProjectSearch({
  children,
}: WithEntitySearchProps<ProjectShortcode>) {
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const parsedCode = parseShortcode(searchQuery);
  const exactCode =
    parsedCode?.type === "project" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...entityListFor("project").queryOptions({
      filters: { search: searchQuery },
      pagination,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() === "",
  });
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...search.find.queryOptions({
      query: searchQuery || "project",
      entityTypes: ["project"],
      limit: 20,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    entityDetailFor("project").queryOptions(exactCode ?? "PRJ-2222", {
      enabled: exactCode != null,
    }),
  );

  const items = searchingByCode
    ? exactItem
      ? [buildProjectComboboxItem(exactItem)]
      : []
    : searchQuery.trim()
      ? (searchHits?.map((hit) => buildSearchHitComboboxItem(hit, "project")) ??
        [])
      : (data?.items.map(buildProjectComboboxItem) ?? []);

  return (
    <>
      {children({
        items,
        onSearchChange,
        isLoading: exactCode
          ? isExactLoading
          : searchQuery.trim()
            ? isSearchLoading
            : isLoading,
        onOpenChange,
      })}
    </>
  );
}

/**
 * Server-searched task picker — `task.list` filtered by its `search` field,
 * same pattern as `WithRecipeSearch`. No create-from-picker affordance.
 */
export function WithTaskSearch({
  children,
}: WithEntitySearchProps<TaskShortcode>) {
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const parsedCode = parseShortcode(searchQuery);
  const exactCode = parsedCode?.type === "task" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...entityListFor("task").queryOptions({
      filters: { search: searchQuery },
      pagination,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() === "",
  });
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...search.find.queryOptions({
      query: searchQuery || "task",
      entityTypes: ["task"],
      limit: 20,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    entityDetailFor("task").queryOptions(exactCode ?? "TSK-2222", {
      enabled: exactCode != null,
    }),
  );

  return (
    <>
      {children({
        items: searchingByCode
          ? exactItem
            ? [buildTaskComboboxItem(exactItem)]
            : []
          : searchQuery.trim()
            ? (searchHits?.map((hit) =>
                buildSearchHitComboboxItem(hit, "task"),
              ) ?? [])
            : (data?.items.map(buildTaskComboboxItem) ?? []),
        onSearchChange,
        isLoading: exactCode
          ? isExactLoading
          : searchQuery.trim()
            ? isSearchLoading
            : isLoading,
        onOpenChange,
      })}
    </>
  );
}
