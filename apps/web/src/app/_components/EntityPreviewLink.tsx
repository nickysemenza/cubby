import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { lazy, Suspense } from "react";
import { EntityIdentityMark } from "~/components/entity/entity-identity-mark";
import {
  PreviewCard,
  PreviewCardContent,
  PreviewCardTrigger,
} from "~/components/ui/preview-card";
import { Spinner } from "~/components/ui/spinner";
import { entities, entityDetailParams } from "~/entities/entities";
import { cn } from "~/lib/utils";
import type { HoverPreviewEntity } from "./preview/preview-entities";

const EntityPreviewContent = lazy(() =>
  import("./EntityPreviewContent").then((module) => ({
    default: module.EntityPreviewContent,
  })),
);

// A link to a recipe/ingredient detail page that, on hover/focus, opens a
// compact preview hovercard (lazily fetched). The shared core behind both the
// dense recipe views (plain-text children) and EntityInlineLink (icon+name
// children) — one place owns "link + preview" for these two entity types.
//
// On touch (iOS, the PWA target) there's no hover; the link tap navigates, so
// the preview is a pure pointer-device enhancement with no touch regression.

/**
 * Plain-text link styling for the dense recipe views (prep/matrix/nested-spec):
 * a dotted underline that turns solid + primary on hover. Mirrors the
 * EntityInlineLink underline treatment so links read consistently app-wide.
 */
export const dottedEntityLink =
  "underline decoration-border/70 decoration-dotted underline-offset-2 transition-colors hover:text-primary hover:decoration-primary hover:decoration-solid";

type EntityPreviewLinkProps = {
  entity: HoverPreviewEntity;
  /**
   * The canonical public id used for both navigation and the preview query.
   * For `usda-food` this is `String(fdc_id)`.
   */
  id: string;
  /** The trigger content — a plain name, or a full pill body. */
  children: ReactNode;
  /** Backend-enriched canonical image for this record, or an explicit null. */
  displayImage: ImageUrlSummary | null;
  /** Preserve entity-specific marks while an image decodes or is unavailable. */
  fallbackMark?: ReactNode;
  /** An adjacent image/mark already supplies identity on this surface. */
  showIdentityMark?: boolean;
  openInNewTab?: boolean;
  className?: string;
};

export function EntityPreviewLink({
  entity,
  id,
  children,
  displayImage,
  fallbackMark,
  showIdentityMark = true,
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
          // usda-food is the one HoverPreviewEntity that isn't shortcode-keyed
          // (its route stays `/usda/$id`, keyed on `String(fdc_id)`) — see the
          // `usda`/`image` carve-out on `entityDetailParams`.
          entity === "usda-food" ? (
            <Link
              to="/usda/$id"
              params={{ id }}
              target={openInNewTab ? "_blank" : undefined}
              rel={openInNewTab ? "noopener noreferrer" : undefined}
              className={cn(
                showIdentityMark && "inline-flex items-center gap-1",
                className,
              )}
            />
          ) : (
            <Link
              to={entities[entity].routes.detail}
              params={entityDetailParams(id)}
              target={openInNewTab ? "_blank" : undefined}
              rel={openInNewTab ? "noopener noreferrer" : undefined}
              className={cn(
                showIdentityMark && "inline-flex items-center gap-1",
                className,
              )}
            />
          )
        }
      >
        {showIdentityMark && (
          <EntityIdentityMark
            entity={entity}
            displayImage={displayImage ?? null}
            fallback={fallbackMark}
          />
        )}
        {children}
      </PreviewCardTrigger>
      <PreviewCardContent>
        <Suspense
          fallback={
            <div className="flex justify-center py-4">
              <Spinner className="text-muted-foreground" />
            </div>
          }
        >
          <EntityPreviewContent entity={entity} id={id} />
        </Suspense>
      </PreviewCardContent>
    </PreviewCard>
  );
}
