import type { WishCandidateOut } from "@cubby/schemas/wish";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entities, entityDetailParams } from "~/entity/entities";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
} from "~/features/products/product-image-summaries";
import { formatCurrency } from "~/lib/utils";
import { Row } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { ImageThumbnail } from "~/ui/table/ImageThumbnail";

import type { EntityDetailFieldRenderers } from "./index";

/**
 * One candidate alternative. Its own component because
 * `useHydratedProductImages` is a hook and cannot be called inside the
 * candidates `.map`.
 */
function WishCandidateRow({ candidate }: { candidate: WishCandidateOut }) {
  const images = useHydratedProductImages(candidate.id);
  return (
    <div className="p-2">
      <Row align="center" justify="between" gap="sm">
        <Row align="center" gap="sm" className="min-w-0">
          <span className="block size-10 shrink-0">
            <ImageThumbnail
              images={images}
              alt={candidate.name}
              lazyPreview
              entity="product"
            />
          </span>
          <span className="min-w-0">
            <EntityRefLink
              variant="table"
              to={entities.product.routes.detail}
              params={entityDetailParams(candidate.id)}
              className="block truncate"
            >
              {candidate.name}
            </EntityRefLink>
            <span className="block truncate text-muted-foreground">
              {candidate.manufacturer}
              {candidate.model ? ` · ${candidate.model}` : ""}
            </span>
          </span>
        </Row>
        <Row as="span" align="center" gap="sm">
          {candidate.inventoried && (
            <Badge variant="positive">In inventory</Badge>
          )}
          {candidate.price !== null && (
            <span>{formatCurrency(candidate.price)}</span>
          )}
        </Row>
      </Row>
    </div>
  );
}

export const wishDetailFields = {
  // Wishes own no images; the covers belong to the candidate Products and
  // are fetched independently of the Wish detail record, so an
  // unillustrated Product stays an honest placeholder rather than making
  // every wish response heavier.
  "wish-candidates": (wish) => ({
    value:
      wish.candidates.length === 0 ? (
        <span className="text-muted-foreground">
          No specific products yet — this is an open-ended idea.
        </span>
      ) : (
        <ProductImageSummariesProvider
          productIds={wish.candidates.map((candidate) => candidate.id)}
        >
          <div className="divide-y border">
            {wish.candidates.map((candidate) => (
              <WishCandidateRow key={candidate.id} candidate={candidate} />
            ))}
          </div>
        </ProductImageSummariesProvider>
      ),
  }),
} satisfies EntityDetailFieldRenderers<"wish">;
