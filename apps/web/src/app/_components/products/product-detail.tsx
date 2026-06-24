import type { ProductCreateInput } from "@cubby/schemas/product";
import { useQuery } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { Apple, ChefHat, Info, Scale } from "lucide-react";
import type { FC } from "react";
import { MutedBox } from "~/components/layout/muted-box";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { formatCurrency } from "~/lib/utils";
import type { ProductWithFoodOut } from "~/server/services/product.service";
import { useTRPC } from "~/trpc/react";
import {
  type DetailHeroStat,
  DetailPage,
  type DetailSection,
} from "../data-table/detail-page";
import { editableDetailSection } from "../data-table/editable-detail-section";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { RecipeUsagesTable } from "../recipe/recipe-usages-table";
import { ConversionCapabilities } from "../units/ConversionCapabilities";
import { UnitMappingsTable } from "../units/unitmappingstable";
import { NutritionInfoTable } from "../usda/nutrition";
import { ProductBasicInfo } from "./product-basic-info";
import { ProductForm } from "./product-form";

interface ProductDetailProps {
  product: ProductWithFoodOut;
}

export const ProductDetail: FC<ProductDetailProps> = ({ product }) => {
  const api = useTRPC();

  // Subscribe to the same query the route seeded so a background refetch keeps
  // the page fresh — and surfaces a consistent not-found / error state if the
  // entity disappears or a refetch fails after the initial Suspense load.
  const query = useQuery({
    ...api.product.getByID.queryOptions({ id: product.id }),
    initialData: product,
  });

  const { commonSections, editMode, mappings } = useEntityDetail<
    ProductWithFoodOut,
    { id: string; data: Partial<ProductCreateInput> }
  >({
    entity: "product",
    data: product,
    mutationOptions: api.product.update.mutationOptions(),
    getMappings: getAllUnitMappingsFromProduct,
  });

  const sections: DetailSection[] = [
    editableDetailSection({
      title: "Basic Information",
      icon: Info,
      editMode,
      Form: ProductForm,
      entity: product,
      children: (
        <ProductBasicInfo product={product} onEdit={editMode.startEditing} />
      ),
    }),
    // Custom section: Nutrition (only if available)
    ...(product.food?.nutritionInfo
      ? [
          {
            title: "Nutrition Information",
            icon: Apple,
            content: (
              <MutedBox>
                <NutritionInfoTable n={product.food.nutritionInfo} />
              </MutedBox>
            ),
          },
        ]
      : []),
    // Custom section: Unit Mappings — conversion capabilities + Convert modal
    // above the source-attributed rows table, mirroring the ingredient page.
    {
      title: "Unit Mappings",
      icon: Scale,
      content: (
        <div className="space-y-2">
          <ConversionCapabilities mappings={mappings} />
          <UnitMappingsTable mappings={mappings} />
        </div>
      ),
    },
    // Custom section: Appears In Recipes — recipes the product's linked ingredient
    // is used in, one row per usage with amount, source line, and parser-drift flag.
    // Full-width so the 5-column table has room (esp. the source line).
    ...(product.ingredient
      ? [
          {
            title: "Appears In Recipes",
            icon: ChefHat,
            fullWidth: true,
            content:
              product.recipeUsages.length > 0 ? (
                <RecipeUsagesTable
                  usages={product.recipeUsages}
                  ingredientName={product.ingredient.name}
                  aliases={product.ingredient.aliases}
                />
              ) : (
                <p className="text-muted-foreground text-sm">
                  Not used in any recipes yet.
                </p>
              ),
          },
        ]
      : []),
    // Common sections from entity config (History)
    ...commonSections,
  ];

  const entries = product.inventoryEntry ?? [];
  const locationCount = uniq(entries.map((e) => e.location.id)).length;
  const heroStats: DetailHeroStat[] = [
    { label: "On hand", value: entries.length },
    { label: "Locations", value: locationCount },
    ...(product.price != null
      ? [{ label: "Price", value: formatCurrency(product.price) }]
      : []),
  ];

  return (
    <DetailPage
      sections={sections}
      entity="product"
      name={product.name}
      rawData={product}
      error={query.error ?? undefined}
      notFound={query.data == null}
      heroImages={product.images}
      heroNo={product.shortcode ?? undefined}
      heroStamp={
        entries.length > 0
          ? { label: "In stock", tone: "green" }
          : { label: "Not stocked", tone: "ink" }
      }
      heroStats={heroStats}
    />
  );
};
