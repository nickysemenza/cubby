import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { match } from "ts-pattern";
import {
  PreviewCard,
  PreviewCardContent,
  PreviewCardTrigger,
} from "~/components/ui/preview-card";
import { entities } from "~/entities/entities";
import { fdcIdFromParam } from "~/entities/entity-query";
import {
  IngredientPreviewContent,
  LocationPreviewContent,
  ProductPreviewContent,
  RecipePreviewContent,
  UsdaFoodPreviewContent,
} from "./EntityPreviewContent";

// A link to a recipe/ingredient detail page that, on hover/focus, opens a
// compact preview hovercard (lazily fetched). The shared core behind both the
// dense recipe views (plain-text children) and EntityPillLink (icon+name
// children) — one place owns "link + preview" for these two entity types.
//
// On touch (iOS, the PWA target) there's no hover; the link tap navigates, so
// the preview is a pure pointer-device enhancement with no touch regression.

/**
 * Plain-text link styling for the dense recipe views (prep/matrix/nested-spec):
 * a dotted underline that turns solid + primary on hover. Mirrors the
 * EntityPillLink underline treatment so links read consistently app-wide.
 */
export const dottedEntityLink =
  "underline decoration-border/70 decoration-dotted underline-offset-2 transition-colors hover:text-primary hover:decoration-primary hover:decoration-solid";

type PreviewEntity =
  | "recipe"
  | "ingredient"
  | "product"
  | "usda-food"
  | "location";

type EntityPreviewLinkProps = {
  entity: PreviewEntity;
  /** Route param id. For usda-food this is String(fdc_id). */
  id: string;
  /** The trigger content — a plain name, or a full pill body. */
  children: ReactNode;
  openInNewTab?: boolean;
  className?: string;
};

export function EntityPreviewLink({
  entity,
  id,
  children,
  openInNewTab,
  className,
}: EntityPreviewLinkProps) {
  return (
    <PreviewCard>
      <PreviewCardTrigger
        // Open a touch faster than the 600ms default; close promptly.
        delay={300}
        closeDelay={150}
        render={
          <Link
            to={entities[entity].routes.detail}
            params={{ id }}
            target={openInNewTab ? "_blank" : undefined}
            rel={openInNewTab ? "noopener noreferrer" : undefined}
            className={className}
          />
        }
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardContent>
        {match(entity)
          .with("recipe", () => <RecipePreviewContent recipeId={id} />)
          .with("ingredient", () => (
            <IngredientPreviewContent ingredientId={id} />
          ))
          .with("product", () => <ProductPreviewContent productId={id} />)
          .with("usda-food", () => (
            <UsdaFoodPreviewContent fdcId={fdcIdFromParam(id)} />
          ))
          .with("location", () => <LocationPreviewContent locationId={id} />)
          .exhaustive()}
      </PreviewCardContent>
    </PreviewCard>
  );
}
