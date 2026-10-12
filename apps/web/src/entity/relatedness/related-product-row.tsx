import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { LedgerCell, LedgerRow } from "~/ui/common/ledger";

/**
 * One compact product identity row for derived relationship surfaces. The
 * caller supplies canonical media; this component never guesses from a local
 * product projection.
 */
export function RelatedProductRow({
  product,
  displayImage,
  evidence,
  action,
}: {
  product: { id: string; name: string };
  displayImage: ImageUrlSummary | null;
  evidence?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <LedgerRow>
      <LedgerCell slot="primary">
        <EntityRefLink
          entity="product"
          data={product}
          displayImage={displayImage}
          truncate
        />
      </LedgerCell>
      {evidence && (
        <LedgerCell slot="secondary" className="text-xs text-muted-foreground">
          {evidence}
        </LedgerCell>
      )}
      {action && <LedgerCell slot="trailing">{action}</LedgerCell>}
    </LedgerRow>
  );
}
