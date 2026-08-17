import type {
  IngredientShortcode,
  LocationShortcode,
  ProductShortcode,
  ProjectShortcode,
  RecipeShortcode,
  TaskShortcode,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import { unsafeVendorShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { locationType } from "@cubby/schemas/location";
import type { SearchableEntity, SearchHit } from "@cubby/schemas/search";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { locationToSegments } from "~/app/_components/locations/location-breadcrumb";
import { LocationPickerThumb } from "~/app/_components/locations/location-picker-thumb";
import { resolveLocationPrimaryVisual } from "~/app/_components/locations/location-visual-resolver";
import { ProjectMark } from "~/app/projects/project-mark";
import { VendorMark } from "~/components/entity/vendor-cell";
import { Image } from "~/components/ui/image";
import { EntityIcon } from "~/entities/entities";

export type ProductPickerIntent = "reference" | "stock";

const formatPickerQuantity = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toLocaleString();

const humanizePickerValue = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());

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

/** Maps compact indexed-search hits into the picker contract. */
export function buildSearchHitComboboxItem<TId extends string>(
  hit: SearchHit,
  entity: SearchableEntity,
): ComboboxItem<TId> {
  const locationKind =
    entity === "location" ? locationType.safeParse(hit.typeHint).data : null;
  const fallback = locationKind ? (
    <LocationPickerThumb imageUrl={hit.imageUrl} type={locationKind} />
  ) : entity === "vendor" ? (
    <VendorMark vendor={hit.title} vendorId={unsafeVendorShortcode(hit.id)} />
  ) : (
    <SearchPickerIcon
      entity={entity}
      imageUrl={hit.imageUrl}
      typeHint={hit.typeHint}
    />
  );

  return {
    // The server applies the entityTypes scope; narrowing it here preserves the
    // branded value each picker writes without ever exposing a private UUID.
    id: hit.id as TId,
    shortcode: hit.id,
    name: hit.title,
    secondary: hit.subtitle ?? hit.typeHint ?? undefined,
    detail: hit.subtitle && hit.typeHint ? hit.typeHint : undefined,
    presentation:
      hit.matchField === "title" || hit.matchField === "shortcode"
        ? undefined
        : { facts: [hit.matchReason] },
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
    category?: string | null;
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
  const inventoryUnits = new Set(
    product.inventoryEntry?.map((entry) => entry.amount.unit) ?? [],
  );
  const derivedOnHand =
    product.onHandUnits != null
      ? ({ state: "counted", units: product.onHandUnits } as const)
      : product.inventoryEntry == null || ledger == null
        ? undefined
        : inventoryUnits.size > 1
          ? ({ state: "mixed" } as const)
          : product.inventoryEntry.length === 0 && ledger.locationCount === 0
            ? ({ state: "none" } as const)
            : ({
                state: "counted",
                units:
                  product.inventoryEntry.reduce(
                    (sum, entry) => sum + entry.amount.value,
                    0,
                  ) + ledger.locationCount,
              } as const);
  const onHand = product.onHand ?? derivedOnHand;
  const base: ComboboxItem<ProductShortcode> = {
    id: product.id,
    shortcode: product.id,
    name: product.name,
    aliases: product.aliases ?? [],
    secondary: product.manufacturer,
    detail: product.category ?? undefined,
    icon: <EntityIcon entity="product" size={14} colored />,
  };
  if (!ledger || !onHand) return base;

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

  if (intent === "reference") {
    return { ...base, presentation: { facts } };
  }

  const uncertain = unknownLines > 0 || knownOnHand === null || expected < 0;
  if (uncertain) {
    return {
      ...base,
      presentation: {
        group: { id: "check", label: "Check quantity", order: 1 },
        status: { label: "Check quantity", tone: "warning" },
        facts,
      },
    };
  }

  const need = expected - knownOnHand;
  if (need > 0) {
    return {
      ...base,
      presentation: {
        group: { id: "needs-stock", label: "Needs stocking", order: 0 },
        status: {
          label: `Need ${formatPickerQuantity(need)}`,
          tone: "positive",
        },
        facts,
      },
    };
  }

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
};

/**
 * `ancestors` and `coverImage` are optional because three shapes feed this
 * builder: the search endpoint (both present), a by-shortcode read (ancestors
 * derived from its nested parent chain, see `locationToSegments`), and a
 * freshly-created location (neither — it has no parent chain loaded yet).
 */
export const buildLocationComboboxItem = (location: {
  id: LocationShortcode;
  name: string;
  type: LocationType | null;
  aliases?: string[] | null;
  ancestors?: Array<{ name: string }> | null;
  coverImage?: { url: string } | null;
}): ComboboxItem<LocationShortcode> => ({
  id: location.id,
  shortcode: location.id,
  name: location.name,
  aliases: location.aliases ?? [],
  secondary: location.type ?? undefined,
  detail: location.ancestors?.length
    ? location.ancestors.map((ancestor) => ancestor.name).join(" › ")
    : undefined,
  icon: (
    <LocationPickerThumb
      imageUrl={location.coverImage?.url}
      type={location.type}
    />
  ),
});

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

export const buildIngredientComboboxItem = (ingredient: {
  id: IngredientShortcode;
  name: string;
  aliases?: string[] | null;
  product?: unknown[];
  ownRecipeCount?: number;
}): ComboboxItem<IngredientShortcode> => {
  const facts = [
    ingredient.product
      ? `${ingredient.product.length} ${ingredient.product.length === 1 ? "product" : "products"}`
      : null,
    ingredient.ownRecipeCount != null
      ? `${ingredient.ownRecipeCount} own ${ingredient.ownRecipeCount === 1 ? "recipe" : "recipes"}`
      : null,
  ].filter((fact): fact is string => fact != null);
  return {
    id: ingredient.id,
    shortcode: ingredient.id,
    name: ingredient.name,
    aliases: ingredient.aliases ?? [],
    presentation: facts.length ? { facts } : undefined,
    icon: <EntityIcon entity="ingredient" size={14} colored />,
  };
};

export const buildRecipeComboboxItem = (recipe: {
  id: RecipeShortcode;
  name: string;
  meta?: {
    times?: { totalMinutes?: number | null } | null;
    page?: string | null;
    url?: string | null;
  } | null;
}): ComboboxItem<RecipeShortcode> => {
  const facts = [
    recipe.meta?.times?.totalMinutes != null
      ? `${recipe.meta.times.totalMinutes} min`
      : null,
    recipe.meta?.page ? `Page ${recipe.meta.page}` : null,
    recipe.meta?.url ? "Web recipe" : null,
  ].filter((fact): fact is string => fact != null);
  return {
    id: recipe.id,
    shortcode: recipe.id,
    name: recipe.name,
    presentation: facts.length ? { facts } : undefined,
    icon: <EntityIcon entity="recipe" size={14} colored />,
  };
};

export const buildProjectComboboxItem = (project: {
  id: ProjectShortcode;
  name: string;
  icon?: string | null;
  status?: string;
  kind?: string | null;
  parentProjectName?: string | null;
}): ComboboxItem<ProjectShortcode> => {
  const done = project.status === "done";
  return {
    id: project.id,
    shortcode: project.id,
    name: project.name,
    secondary: project.kind ? humanizePickerValue(project.kind) : undefined,
    detail: project.parentProjectName ?? undefined,
    presentation: project.status
      ? {
          group: done
            ? { id: "completed", label: "Completed projects", order: 1 }
            : { id: "active", label: "Active projects", order: 0 },
          status: { label: humanizePickerValue(project.status) },
        }
      : undefined,
    icon: <ProjectMark icon={project.icon} />,
  };
};

export const buildTaskComboboxItem = (task: {
  id: TaskShortcode;
  name: string;
  status?: string;
  projectName?: string | null;
  dueDate?: string | null;
  trade?: string | null;
}): ComboboxItem<TaskShortcode> => {
  const done = task.status === "done";
  const facts = [
    task.dueDate ? `Due ${task.dueDate}` : null,
    task.trade ? humanizePickerValue(task.trade) : null,
  ].filter((fact): fact is string => fact != null);
  return {
    id: task.id,
    shortcode: task.id,
    name: task.name,
    secondary: task.projectName ?? undefined,
    presentation: task.status
      ? {
          group: done
            ? { id: "completed", label: "Completed tasks", order: 1 }
            : { id: "open", label: "Open tasks", order: 0 },
          status: { label: humanizePickerValue(task.status) },
          facts,
        }
      : facts.length
        ? { facts }
        : undefined,
    icon: <EntityIcon entity="task" size={14} colored />,
  };
};

export const buildVendorNameComboboxItem = (vendor: {
  id: VendorShortcode;
  name: string;
  count?: number;
}): ComboboxItem<string> => ({
  id: vendor.name,
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
  icon: <VendorMark vendor={vendor.name} vendorId={vendor.id} />,
});

export const buildVendorShortcodeComboboxItem = (vendor: {
  id: VendorShortcode;
  name: string;
  count?: number;
}): ComboboxItem<VendorShortcode> => ({
  id: vendor.id,
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
  icon: <VendorMark vendor={vendor.name} vendorId={vendor.id} />,
});
