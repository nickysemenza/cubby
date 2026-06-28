import type {
  ProductCreateInput,
  ProductWithFoodOut,
} from "@cubby/schemas/product";
import { uniq } from "es-toolkit";
import { Apple, ChefHat, Info, Scale } from "lucide-react";
import type { FC } from "react";
import { MutedBox } from "~/components/layout/muted-box";
import { Page } from "~/components/page/Page";
import { Description } from "~/components/ui/description";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import {
  type DetailHeroStat,
  type DetailSection,
  DetailSections,
} from "../data-table/detail-page";
import { editableDetailSection } from "../data-table/editable-detail-section";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { RecipeUsagesTable } from "../recipe/recipe-usages-table";
import { UnitCoveragePanel } from "../units/UnitCoveragePanel";
import { NutritionInfoTable } from "../usda/nutrition";
import { ProductBasicInfo } from "./product-basic-info";
import { ProductForm } from "./product-form";

interface ProductDetailProps {
  product: ProductWithFoodOut;
}

export const ProductDetail: FC<ProductDetailProps> = ({ product }) => {
  const api = useTRPC();

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
      content: <UnitCoveragePanel mappings={mappings} />,
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
                <Description>Not used in any recipes yet.</Description>
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
    <Page
      variant="detail"
      entity="product"
      title={product.name}
      rawData={product}
      heroImages={product.images}
      heroNo={product.shortcode ?? undefined}
      heroStamp={
        entries.length > 0
          ? { label: "In stock", tone: "green" }
          : { label: "Not stocked", tone: "ink" }
      }
      heroStats={heroStats}
    >
      <DetailSections
        sections={sections}
        rawData={product}
        heroImages={product.images}
      />
    </Page>
  );
};
