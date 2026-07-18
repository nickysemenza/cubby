import { partitionEntityFiles } from "@cubby/schemas/image";
import type {
  ProductCreateInput,
  ProductWithFoodOut,
} from "@cubby/schemas/product";
import { isNonFoodCategory } from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import {
  Apple,
  ChefHat,
  FileText,
  Info,
  MapPin,
  Package,
  Scale,
} from "lucide-react";
import { type FC, useCallback, useState } from "react";
import { MutedBox } from "~/components/layout/muted-box";
import { Page } from "~/components/page/Page";
import { buttonVariants } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { useTRPC } from "~/integrations/trpc/react";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { cn } from "~/lib/utils";
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
import { type ManualViewTarget, ProductManuals } from "./product-manuals";
import { ProductStockedAt } from "./product-stocked-at";

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

  const isNonFood = isNonFoodCategory(product.category);

  // PDF manuals share the images relation — hero/gallery get only real
  // images; documents render in their own Manuals section.
  const { images, documents } = partitionEntityFiles(product.images);

  // Wiki links in the notes ([[manual#page=N]]) jump the inline viewer here.
  const [manualTarget, setManualTarget] = useState<ManualViewTarget | null>(
    null,
  );
  const handleManualLink = useCallback((documentId: string, page: number) => {
    setManualTarget({ documentId, page, nonce: Date.now() });
  }, []);

  const sections: DetailSection[] = [
    editableDetailSection({
      title: "Basic Information",
      icon: Info,
      editMode,
      Form: ProductForm,
      entity: product,
      children: (
        <ProductBasicInfo
          product={product}
          onEdit={editMode.startEditing}
          documents={documents}
          onManualLink={handleManualLink}
        />
      ),
    }),
    // Custom section: Stocked At — where the product lives, the primary
    // content of the page (the hero's On hand / Locations stats are the
    // glanceable summary of this table).
    {
      title: "Stocked At",
      icon: MapPin,
      zone: "main" as const,
      headerAction: (
        <Link
          to="/inventory/session"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <Package className="mr-2 h-4 w-4" />
          Add to Inventory
        </Link>
      ),
      content: <ProductStockedAt product={product} />,
    },
    // Custom section: Manuals — attached PDF instruction manuals (only if any)
    ...(documents.length > 0
      ? [
          {
            title: "Manuals",
            icon: FileText,
            zone: "main" as const,
            content: (
              <ProductManuals documents={documents} target={manualTarget} />
            ),
          },
        ]
      : []),
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
    // Non-food (household/garage) products skip food-coverage grading entirely
    // (no calories/price chips, no USDA nudge) — and with no mappings at all,
    // collapse to a minimal note instead of an empty converter surface.
    ...(isNonFood && mappings.length === 0
      ? [
          {
            title: "Unit Mappings",
            icon: Scale,
            zone: "main" as const,
            content: (
              <Description>
                No unit conversions — not needed for non-food items.
              </Description>
            ),
          },
        ]
      : [
          {
            title: "Unit Mappings",
            icon: Scale,
            zone: "main" as const,
            content: (
              <UnitCoveragePanel
                mappings={mappings}
                showCoverage={!isNonFood}
              />
            ),
          },
        ]),
    // Custom section: Appears In Recipes — recipes the product's linked ingredient
    // is used in, one row per usage with amount, source line, and parser-drift flag.
    // Full-width so the 5-column table has room (esp. the source line).
    ...(product.ingredient
      ? [
          {
            title: "Appears In Recipes",
            icon: ChefHat,
            zone: "full" as const,
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
  // No Price stat here — the editable price field in Basic Information is
  // the source of truth and sits right in the aside rail.
  const heroStats: DetailHeroStat[] = [
    { label: "On hand", value: entries.length },
    { label: "Locations", value: locationCount },
  ];

  return (
    <Page
      variant="detail"
      entity="product"
      title={product.name}
      rawData={product}
      heroImages={images}
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
        heroImages={images}
      />
    </Page>
  );
};
