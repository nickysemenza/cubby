import type { LocationType } from "@cubby/schemas/location";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import type { DataType } from "@cubby/usda-schemas";
import { dataTypeLabel } from "@cubby/usda-schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { sumBy } from "es-toolkit";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { Spinner } from "~/components/ui/spinner";
import { EntityIcon } from "~/entities/entities";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { dataTypeColor, UsdaDataTypeDot } from "~/lib/usda-data-type";
import { formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { EntityPillLink } from "./EntityPill";
import { LocationIcon } from "./locations/location-icons";
import { formatYield } from "./recipe/recipe-utils";
import { NutrientsSummary } from "./units/NutrientsSummary";

// Unified "manifest" hovercard body shared by every entity preview: a common
// header block (icon · name · Open · type tag · one identity line), a row of
// navigation cross-links, then the entity-specific stats filling the free
// space below.
//
// Each entity is split into a pure *PreviewBody (renders a small view-model —
// reused statically by the /design gallery) and a thin *PreviewContent wrapper
// that fetches via tRPC getByID (React-Query cached, only mounts while the
// popup is open) and maps the payload into that view-model.

// ── Shared building blocks ──────────────────────────────────────────────────

const actionLink =
  "inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-primary hover:underline";
const openIcon =
  "shrink-0 text-primary transition-colors hover:text-primary/70";

function ManifestShell({
  icon,
  name,
  tag,
  open,
  identity,
  links,
  children,
}: {
  icon: ReactNode;
  name: string;
  tag: string;
  /** The "Open" affordance, shown in the header strip between name and tag. */
  open: ReactNode;
  identity?: ReactNode;
  /** Cross-links to related entities; the divided strip is omitted when empty. */
  links?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 self-start">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 font-heading font-medium text-sm leading-tight">
              {name}
            </span>
            <div className="mt-px flex shrink-0 items-center gap-1.5">
              {open}
              <span className="rounded-sm bg-muted px-1.5 py-px font-mono text-[9px] text-muted-foreground uppercase tracking-wide">
                {tag}
              </span>
            </div>
          </div>
          {identity && (
            <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground text-xs">
              {identity}
            </div>
          )}
        </div>
      </div>
      {links && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border/60 border-y border-dashed py-1.5 text-xs">
          {links}
        </div>
      )}
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
      {children}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col">
      <SectionLabel>{label}</SectionLabel>
      <span className="font-medium text-sm tabular-nums">{value}</span>
    </div>
  );
}

function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">{children}</div>;
}

function Nutrients({ nutrients }: { nutrients: Record<string, number> }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel>Per 100g</SectionLabel>
      <NutrientsSummary nutrients={nutrients} dense />
    </div>
  );
}

function PriceValue({ amount, from }: { amount: number; from?: boolean }) {
  return (
    <>
      {from && <span className="text-muted-foreground text-xs">from </span>}
      {formatCurrency(amount)}
      <span className="text-muted-foreground text-xs">/ea</span>
    </>
  );
}

function Thumb({ url }: { url: string }) {
  return (
    <img
      src={url}
      alt=""
      className="h-24 w-full rounded-md border border-border object-cover"
    />
  );
}

function PreviewLoading() {
  return (
    <div className="flex items-center justify-center py-3">
      <Spinner className="text-muted-foreground" />
    </div>
  );
}

function PreviewDeleted({ label }: { label: string }) {
  return (
    <span className="text-muted-foreground text-sm italic">
      {label} (deleted)
    </span>
  );
}

// ── Recipe ──────────────────────────────────────────────────────────────────

export type RecipePreview = {
  id: string;
  name: string;
  yieldText?: string;
  cost?: number;
  calories?: number;
  ingredientCount: number;
  stepCount: number;
  thumbUrl?: string;
};

export function RecipePreviewBody(p: RecipePreview) {
  return (
    <ManifestShell
      icon={<EntityIcon entity="recipe" size={14} colored />}
      name={p.name}
      tag="recipe"
      identity={p.yieldText}
      open={
        <Link
          to="/recipes/$id"
          params={{ id: p.id }}
          aria-label="Open"
          className={openIcon}
        >
          <ArrowUpRight className="size-3.5" />
        </Link>
      }
      links={
        <Link
          to="/recipes/$id"
          params={{ id: p.id }}
          search={{ view: "prep" }}
          className={actionLink}
        >
          Prep sheet
        </Link>
      }
    >
      {p.thumbUrl && <Thumb url={p.thumbUrl} />}
      <StatGrid>
        {p.cost != null && <Stat label="Cost" value={formatCurrency(p.cost)} />}
        {p.calories != null && (
          <Stat label="Calories" value={`${Math.round(p.calories)} kcal`} />
        )}
        <Stat label="Ingredients" value={p.ingredientCount} />
        {p.stepCount > 0 && <Stat label="Steps" value={p.stepCount} />}
      </StatGrid>
    </ManifestShell>
  );
}

export function RecipePreviewContent({ recipeId }: { recipeId: string }) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.recipe.getByID.queryOptions({ id: recipeId }),
  );

  if (isLoading) return <PreviewLoading />;
  if (!data) return <PreviewDeleted label="Recipe" />;

  return (
    <RecipePreviewBody
      id={recipeId}
      name={data.name}
      yieldText={
        data.yield?.value
          ? `makes ${formatYield(data.yield)}`
          : data.servings
            ? `${data.servings} servings`
            : undefined
      }
      cost={data.totals?.costTotal}
      calories={data.totals?.caloriesTotal}
      ingredientCount={
        data.totals?.ingredientCount ??
        sumBy(data.sections, (s) => s.ingredients.length)
      }
      stepCount={sumBy(data.sections, (s) => s.instructions.length)}
      thumbUrl={data.images[0]?.url}
    />
  );
}

// ── Ingredient ──────────────────────────────────────────────────────────────

export type IngredientPreview = {
  id: string;
  name: string;
  aliases: string[];
  nutrients?: Record<string, number>;
  cheapestPrice?: number;
  multiplePrices: boolean;
  recipeCount: number;
  usdaFdcId?: number;
  products: { id: string; name: string; manufacturer: string }[];
};

export function IngredientPreviewBody(p: IngredientPreview) {
  return (
    <ManifestShell
      icon={<EntityIcon entity="ingredient" size={14} colored />}
      name={p.name}
      tag="ingredient"
      identity={
        p.aliases.length > 0 ? `aka ${p.aliases.join(", ")}` : undefined
      }
      open={
        <Link
          to="/ingredients/$id"
          params={{ id: p.id }}
          aria-label="Open"
          className={openIcon}
        >
          <ArrowUpRight className="size-3.5" />
        </Link>
      }
      links={
        p.usdaFdcId != null ? (
          <Link
            to="/usda/$id"
            params={{ id: String(p.usdaFdcId) }}
            className={actionLink}
          >
            USDA food
          </Link>
        ) : undefined
      }
    >
      {p.nutrients && <Nutrients nutrients={p.nutrients} />}
      <StatGrid>
        {p.cheapestPrice != null && (
          <Stat
            label="Price"
            value={
              <PriceValue amount={p.cheapestPrice} from={p.multiplePrices} />
            }
          />
        )}
        <Stat label="Recipes" value={p.recipeCount} />
      </StatGrid>
      {p.products.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionLabel>
            Product{p.products.length === 1 ? "" : "s"}
          </SectionLabel>
          <div className="flex flex-col gap-0.5">
            {p.products.slice(0, 4).map((prod) => (
              <EntityPillLink
                key={prod.id}
                entity="product"
                data={prod}
                compact
              />
            ))}
            {p.products.length > 4 && (
              <span className="text-2xs text-muted-foreground">
                +{p.products.length - 4} more
              </span>
            )}
          </div>
        </div>
      )}
    </ManifestShell>
  );
}

export function IngredientPreviewContent({
  ingredientId,
}: {
  ingredientId: string;
}) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.ingredient.getByID.queryOptions({ id: ingredientId }),
  );

  if (isLoading) return <PreviewLoading />;
  if (!data) return <PreviewDeleted label="Ingredient" />;

  const prices = data.product
    .map((prod) => prod.price)
    .filter((v): v is number => v != null);

  return (
    <IngredientPreviewBody
      id={ingredientId}
      name={data.name}
      aliases={data.aliases ?? []}
      nutrients={
        data.product.find((prod) => prod.food?.nutritionInfo)?.food
          ?.nutritionInfo.nutrientsPer100
      }
      cheapestPrice={prices.length > 0 ? Math.min(...prices) : undefined}
      multiplePrices={prices.length > 1}
      recipeCount={data.appearsInRecipes.length}
      usdaFdcId={data.product.find((prod) => prod.food)?.food?.fdc_id}
      products={data.product.map((prod) => ({
        id: prod.id,
        name: prod.name,
        manufacturer: prod.manufacturer,
      }))}
    />
  );
}

// ── Product ─────────────────────────────────────────────────────────────────

export type ProductPreview = {
  id: string;
  name: string;
  identity?: string;
  nutrients?: Record<string, number>;
  price?: number;
  upc?: string;
  thumbUrl?: string;
  usdaFdcId?: number;
};

export function ProductPreviewBody(p: ProductPreview) {
  return (
    <ManifestShell
      icon={<EntityIcon entity="product" size={14} colored />}
      name={p.name}
      tag="product"
      identity={p.identity}
      open={
        <Link
          to="/products/$id"
          params={{ id: p.id }}
          aria-label="Open"
          className={openIcon}
        >
          <ArrowUpRight className="size-3.5" />
        </Link>
      }
      links={
        p.usdaFdcId != null ? (
          <Link
            to="/usda/$id"
            params={{ id: String(p.usdaFdcId) }}
            className={actionLink}
          >
            USDA food
          </Link>
        ) : undefined
      }
    >
      {p.thumbUrl && <Thumb url={p.thumbUrl} />}
      {p.nutrients && <Nutrients nutrients={p.nutrients} />}
      {(p.price != null || p.upc) && (
        <StatGrid>
          {p.price != null && (
            <Stat label="Price" value={<PriceValue amount={p.price} />} />
          )}
          {p.upc && (
            <Stat
              label="UPC"
              value={<span className="font-mono text-xs">{p.upc}</span>}
            />
          )}
        </StatGrid>
      )}
    </ManifestShell>
  );
}

export function ProductPreviewContent({ productId }: { productId: string }) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.product.getByID.queryOptions({ id: productId }),
  );

  if (isLoading) return <PreviewLoading />;
  if (!data) return <PreviewDeleted label="Product" />;

  const isMisc = isMiscProduct(data.name);
  const manufacturer =
    !isMisc &&
    data.manufacturer &&
    !isUnspecifiedManufacturer(data.manufacturer)
      ? data.manufacturer
      : null;

  return (
    <ProductPreviewBody
      id={productId}
      name={isMisc ? getMiscDisplayName(data.name) : data.name}
      identity={
        [isMisc ? "misc" : manufacturer, data.category]
          .filter(Boolean)
          .join(" · ") || undefined
      }
      nutrients={data.food?.nutritionInfo.nutrientsPer100}
      price={data.price ?? undefined}
      upc={data.upc ?? undefined}
      thumbUrl={data.images[0]?.url}
      // The resolved USDA food (explicit fdc_id or UPC-matched) lives on `food`.
      usdaFdcId={data.food?.fdc_id ?? data.fdc_id ?? undefined}
    />
  );
}

// ── USDA food ───────────────────────────────────────────────────────────────

export type UsdaPreview = {
  fdcId: number;
  name: string;
  dataType?: DataType;
  brand?: string;
  nutrients: Record<string, number>;
  linkedProductId?: string;
};

export function UsdaFoodPreviewBody(p: UsdaPreview) {
  return (
    <ManifestShell
      icon={
        p.dataType ? (
          <EntityIcon
            entity="usda-food"
            size={14}
            style={{ color: dataTypeColor(p.dataType) }}
          />
        ) : (
          <EntityIcon entity="usda-food" size={14} colored />
        )
      }
      name={p.name}
      tag="usda"
      identity={
        p.dataType ? (
          <>
            <UsdaDataTypeDot dataType={p.dataType} />
            {dataTypeLabel(p.dataType)}
            {p.brand && <span>· {p.brand}</span>}
          </>
        ) : undefined
      }
      open={
        <Link
          to="/usda/$id"
          params={{ id: String(p.fdcId) }}
          aria-label="Open"
          className={openIcon}
        >
          <ArrowUpRight className="size-3.5" />
        </Link>
      }
      links={
        p.linkedProductId ? (
          <Link
            to="/products/$id"
            params={{ id: p.linkedProductId }}
            className={actionLink}
          >
            Product
          </Link>
        ) : undefined
      }
    >
      <Nutrients nutrients={p.nutrients} />
    </ManifestShell>
  );
}

export function UsdaFoodPreviewContent({ fdcId }: { fdcId: number }) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.usda.getByID.queryOptions({ id: fdcId }),
  );

  if (isLoading) return <PreviewLoading />;
  if (!data) return <PreviewDeleted label="Food" />;

  return (
    <UsdaFoodPreviewBody
      fdcId={fdcId}
      name={data.foodInfo.description || "Unnamed Food"}
      dataType={data.foodInfo.data_type}
      brand={
        data.brandedFoodInfo?.brand_name ??
        data.brandedFoodInfo?.brand_owner ??
        undefined
      }
      nutrients={data.nutritionInfo.nutrientsPer100}
      linkedProductId={data.linkedProducts?.[0]?.id}
    />
  );
}

// ── Location ────────────────────────────────────────────────────────────────

export type LocationPreview = {
  id: string;
  name: string;
  type: LocationType;
  parent?: { id: string; name: string };
  itemCount?: number;
  subCount?: number;
};

export function LocationPreviewBody(p: LocationPreview) {
  return (
    <ManifestShell
      icon={<LocationIcon type={p.type} size={14} colored />}
      name={p.name}
      tag="location"
      identity={
        <>
          <span>{p.type}</span>
          {p.parent && <span>· in {p.parent.name}</span>}
        </>
      }
      open={
        <Link
          to="/locations/$id"
          params={{ id: p.id }}
          aria-label="Open"
          className={openIcon}
        >
          <ArrowUpRight className="size-3.5" />
        </Link>
      }
      links={
        p.parent ? (
          <Link
            to="/locations/$id"
            params={{ id: p.parent.id }}
            className={actionLink}
          >
            ↑ {p.parent.name}
          </Link>
        ) : undefined
      }
    >
      {(p.itemCount != null || p.subCount != null) && (
        <StatGrid>
          {p.itemCount != null && <Stat label="On hand" value={p.itemCount} />}
          {p.subCount != null && (
            <Stat label="Sub-locations" value={p.subCount} />
          )}
        </StatGrid>
      )}
    </ManifestShell>
  );
}

export function LocationPreviewContent({ locationId }: { locationId: string }) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.location.getByID.queryOptions({ id: locationId }),
  );

  if (isLoading) return <PreviewLoading />;
  if (!data) return <PreviewDeleted label="Location" />;

  return (
    <LocationPreviewBody
      id={locationId}
      name={data.name}
      type={data.type}
      parent={
        data.parent ? { id: data.parent.id, name: data.parent.name } : undefined
      }
      itemCount={data.totalItemCount ?? data.directItemCount ?? undefined}
      subCount={data.childCount ?? data.children?.length ?? undefined}
    />
  );
}
