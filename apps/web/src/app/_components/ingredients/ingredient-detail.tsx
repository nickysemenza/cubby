import type {
  IngredientUpdateInput,
  IngredientWithFoodOut,
} from "@cubby/schemas/ingredient";
import {
  Apple,
  ChefHat,
  Info,
  Scale,
  ShoppingCart,
  Sparkles,
} from "lucide-react";
import { type FC, useState } from "react";
import { Stack } from "~/components/layout";
import { MutedBox } from "~/components/layout/muted-box";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
import { useTRPC } from "~/trpc/react";
import { type DetailSection, DetailSections } from "../data-table/detail-page";
import { editableDetailSection } from "../data-table/editable-detail-section";
import { EntityInlineLinkList } from "../EntityInlineLinkList";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { RecipeUsagesTable } from "../recipe/recipe-usages-table";
import { UnitCoveragePanel } from "../units/UnitCoveragePanel";
import { NutritionInfoTable } from "../usda/nutrition";
import { EnrichIngredientDialog } from "./enrich-ingredient-dialog";
import { IngredientBasicInfo } from "./ingredient-basic-info";
import { IngredientForm } from "./ingredient-form";

interface IngredientDetailProps {
  ingredient: IngredientWithFoodOut;
}

export const IngredientDetail: FC<IngredientDetailProps> = ({ ingredient }) => {
  const api = useTRPC();
  const [isEnriching, setIsEnriching] = useState(false);

  const { commonSections, editMode, mappings } = useEntityDetail<
    IngredientWithFoodOut,
    IngredientUpdateInput
  >({
    entity: "ingredient",
    data: ingredient,
    mutationOptions: api.ingredient.update.mutationOptions(),
    getMappings: getIngredientMappings,
  });

  // Find nutrition info from any product
  const nutritionInfo = ingredient.product.find((p) => p.food?.nutritionInfo)
    ?.food?.nutritionInfo;

  const sections: DetailSection[] = [
    editableDetailSection({
      title: "Basic Information",
      icon: Info,
      editMode,
      Form: IngredientForm,
      entity: ingredient,
      children: (
        <IngredientBasicInfo
          ingredient={ingredient}
          onEdit={editMode.startEditing}
        />
      ),
    }),
    // Custom section: Nutrition (only if available)
    ...(nutritionInfo
      ? [
          {
            title: "Nutrition Information",
            icon: Apple,
            zone: "main" as const,
            content: (
              <MutedBox>
                <NutritionInfoTable n={nutritionInfo} />
              </MutedBox>
            ),
          },
        ]
      : []),
    // Custom section: Related Products
    {
      title: "Related Products",
      icon: ShoppingCart,
      content: (
        <Stack gap="sm">
          {ingredient.product.length > 0 ? (
            <EntityInlineLinkList entity="product" items={ingredient.product} />
          ) : (
            <Description>
              No products linked yet — enrich this ingredient to add pricing and
              nutrition.
            </Description>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsEnriching(true)}
          >
            <Sparkles className="h-4 w-4" />
            Enrich
          </Button>
        </Stack>
      ),
    },
    // Custom section: Unit Mappings — conversion capabilities + Convert modal
    // above the source-attributed table (table shows which product/food each
    // mapping came from, since ingredient mappings aggregate across products).
    {
      title: "Unit Mappings",
      icon: Scale,
      zone: "main",
      content: <UnitCoveragePanel mappings={mappings} />,
    },
    // Custom section: Appears In Recipes — one row per usage, with amount,
    // source line, and a read-only parser-drift flag. Full-width so the 5-column
    // table has room (esp. the source line).
    {
      title: "Appears In Recipes",
      icon: ChefHat,
      zone: "full",
      content:
        ingredient.recipeUsages.length > 0 ? (
          <RecipeUsagesTable
            usages={ingredient.recipeUsages}
            ingredientName={ingredient.name}
            aliases={ingredient.aliases}
          />
        ) : (
          <Description>Not used in any recipes yet.</Description>
        ),
    },
    // Common sections from entity config (History)
    ...commonSections,
  ];

  return (
    <>
      <Page
        variant="detail"
        entity="ingredient"
        title={ingredient.name}
        rawData={ingredient}
      >
        <DetailSections sections={sections} rawData={ingredient} />
      </Page>
      <EnrichIngredientDialog
        ingredient={
          isEnriching ? { id: ingredient.id, name: ingredient.name } : null
        }
        onOpenChange={(open) => {
          if (!open) setIsEnriching(false);
        }}
      />
    </>
  );
};
