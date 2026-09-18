import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { ReactNode } from "react";

import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Row, Stack } from "~/components/layout";

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
    <Row
      align="center"
      justify="between"
      gap="sm"
      className="border-b border-border pb-1 last:border-b-0"
    >
      <Stack gap="tight" className="min-w-0">
        <EntityInlineLink
          entity="product"
          data={product}
          displayImage={displayImage}
          truncate
        />
        {evidence && (
          <span className="text-xs text-muted-foreground">{evidence}</span>
        )}
      </Stack>
      {action && <span className="shrink-0">{action}</span>}
    </Row>
  );
}
