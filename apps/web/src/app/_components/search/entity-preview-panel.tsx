import type { Entity } from "@cubby/schemas/entity";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { match } from "ts-pattern";
import { ExpenseDetail } from "~/app/expenses/expense-detail";
import { FinancialAccountDetail } from "~/app/finance/financial-account-detail";
import { FinancialTransactionDetail } from "~/app/finance/financial-transaction-detail";
import { MealDetailPage } from "~/app/meals/meal-detail-page";
import { ProjectDetailPage } from "~/app/projects/project-detail-page";
import { PurchaseDetail } from "~/app/purchases/purchase-detail";
import { TaskDetail } from "~/app/tasks/task-detail";
import { VendorDetail } from "~/app/vendors/vendor-detail";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { Spinner } from "~/components/ui/spinner";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityQueryOptions, fdcIdFromParam } from "~/entities/entity-query";
import { useTRPC } from "~/integrations/trpc/react";
import { CookbookPreviewContent } from "../EntityPreviewContent";
import { ImageDetail } from "../images/image-detail";
import { IngredientDetail } from "../ingredients/ingredient-detail";
import { InventoryDetail } from "../inventory/inventory-detail";
import { LocationDetail } from "../locations/location-detail";
import { ProductDetail } from "../products/product-detail";
import RecipeDetail from "../recipe/RecipeDetail";
import { USDAFoodDetail } from "../usda/USDAFoodDetail";

interface EntityPreviewPanelProps {
  entityType: Entity;
  id: string;
}

export function EntityPreviewPanel({
  entityType,
  id,
}: EntityPreviewPanelProps) {
  const api = useTRPC();

  // One shared entity→getByID mapping (entity-query), stable for useQuery.
  const queryOptions = useMemo(
    () => entityQueryOptions(api, entityType, id),
    [entityType, id, api],
  );

  // Single query hook instead of 7 disabled ones
  // biome-ignore lint/suspicious/noExplicitAny: useQuery can't narrow the union of getByID queryOptions
  const query = useQuery(queryOptions as any);
  const { isLoading, error, data } = query;

  // Get entity definition for link
  const entityDef = entities[entityType];

  // usda-food/image stay keyed on `$id` (never shortcode-routed). Every other
  // Public entity payloads carry their shortcode in `id`; fall back to the
  // requested id when a specialized payload does not expose an id field.
  const detailLinkParams =
    entityType === "usda-food" || entityType === "image"
      ? { id }
      : entityDetailParams(
          data &&
            typeof data === "object" &&
            "id" in data &&
            typeof data.id === "string"
            ? data.id
            : id,
        );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="md" className="text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-destructive">
        Failed to load {entityDef.label.toLowerCase()}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <SheetHeader
        className={
          "border-b pr-12 pb-4" /* tight: clears the absolute Sheet close button at right-4 */
        }
      >
        <Row align="center" justify="between">
          <SheetTitle>Preview</SheetTitle>
          <Button
            variant="outline"
            size="sm"
            render={
              <Link to={entityDef.routes.detail} params={detailLinkParams} />
            }
          >
            <ExternalLink className="mr-1 size-3" />
            View Full Details
          </Button>
        </Row>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto p-6">
        {match(entityType)
          .with("product", () =>
            data ? <ProductDetail product={data as never} /> : null,
          )
          .with("recipe", () =>
            data ? <RecipeDetail recipe={data as never} /> : null,
          )
          .with("ingredient", () =>
            data ? <IngredientDetail ingredient={data as never} /> : null,
          )
          .with("location", () =>
            data ? <LocationDetail location={data as never} /> : null,
          )
          .with("inventory", () =>
            data ? <InventoryDetail inventoryitem={data as never} /> : null,
          )
          .with("usda-food", () =>
            data ? (
              <USDAFoodDetail id={fdcIdFromParam(id)} food={data as never} />
            ) : null,
          )
          .with("image", () =>
            data ? <ImageDetail image={data as never} /> : null,
          )
          // Meal fetches its own data internally (mealId), unlike the other
          // arms which render off this panel's shared getByID `data`.
          .with("meal", () => <MealDetailPage mealId={id as never} />)
          .with("task", () =>
            data ? <TaskDetail task={data as never} /> : null,
          )
          .with("expense", () =>
            data ? <ExpenseDetail expense={data as never} /> : null,
          )
          .with("project", () =>
            data ? <ProjectDetailPage project={data as never} /> : null,
          )
          // Like meal, the cookbook card fetches its own data (there is no
          // cookbook getByID — it reads the cached browse index).
          .with("cookbook", () => <CookbookPreviewContent cookbookId={id} />)
          .with("vendor", () =>
            data ? <VendorDetail vendor={data as never} /> : null,
          )
          .with("purchase", () =>
            data ? <PurchaseDetail purchase={data as never} /> : null,
          )
          .with("financialAccount", () =>
            data ? <FinancialAccountDetail account={data as never} /> : null,
          )
          .with("financialTransaction", () =>
            data ? (
              <FinancialTransactionDetail transaction={data as never} />
            ) : null,
          )
          .exhaustive()}
      </div>
    </div>
  );
}
