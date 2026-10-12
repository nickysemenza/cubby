import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { RecordRow, RecordScore } from "~/ui/common/record-list";

/**
 * One compact product identity row for derived relationship surfaces. The
 * caller supplies canonical media; this component never guesses from a local
 * product projection.
 */
export function RelatedProductRow({
  product,
  displayImage,
  evidence,
  score,
  actions,
}: {
  product: { id: string; name: string };
  displayImage: ImageUrlSummary | null;
  evidence?: ReactNode;
  /** Similarity in 0–1; zero or absent shows no meter. */
  score?: number;
  actions?: ReactNode;
}) {
  return (
    <RecordRow
      primary={
        <EntityRefLink
          entity="product"
          data={product}
          displayImage={displayImage}
          truncate
        />
      }
      secondary={evidence || null}
      trailing={
        score ? (
          <RecordScore
            value={score}
            label={`${Math.round(score * 100)}% similar`}
          />
        ) : null
      }
      actions={actions}
    />
  );
}
