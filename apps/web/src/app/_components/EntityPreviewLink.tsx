import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { lazy, Suspense } from "react";
import {
  PreviewCard,
  PreviewCardContent,
  PreviewCardTrigger,
} from "~/components/ui/preview-card";
import { Spinner } from "~/components/ui/spinner";
import { entities, entityDetailParams } from "~/entities/entities";
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
            params={entityDetailParams(entity, id)}
            target={openInNewTab ? "_blank" : undefined}
            rel={openInNewTab ? "noopener noreferrer" : undefined}
            className={className}
          />
        }
      >
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
