import { Fragment } from "react";

import {
  MOBILE_SPEC_GRID_CLASS,
  MobileRowShell,
} from "~/components/entity/mobile-card";
import { Stack } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";

/**
 * Loading placeholder for one mobile list row.
 *
 * Built on the same `MobileRowShell` the real row uses, so the grid, divider,
 * and padding can't drift — they already had (this was still on
 * `border-border/30` after the row moved to `/60`).
 *
 * `metaLines` shapes it to the entity being loaded: an expenses list settles
 * into ~5 spec lines per row, so a fixed two-line skeleton would make the list
 * jump the moment real rows arrive.
 */
function MobileCardSkeleton({
  metaLines,
  hasImage,
}: {
  metaLines: number;
  hasImage: boolean;
}) {
  return (
    <MobileRowShell
      tall={metaLines > 0}
      leading={hasImage ? [<Skeleton key="image" className="size-11" />] : []}
      title={<Skeleton className="h-3.5 w-3/4" />}
      content={
        <Stack gap="tight" className="min-w-0">
          <Skeleton className="h-3 w-1/2" />
          {metaLines > 0 && (
            <div className={MOBILE_SPEC_GRID_CLASS}>
              {Array.from({ length: metaLines }, (_, i) => (
                <Fragment key={i}>
                  <Skeleton className="h-2.5 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </Fragment>
              ))}
            </div>
          )}
        </Stack>
      }
      actions={<Skeleton className="size-11" />}
    />
  );
}

export function MobileCardSkeletonList({
  count = 8,
  metaLines = 0,
  hasImage = true,
}: {
  count?: number;
  /** Spec-grid lines the real rows will have — see `mobileListLayout`. */
  metaLines?: number;
  hasImage?: boolean;
}) {
  return (
    <div>
      {Array.from({ length: count }, (_, i) => (
        <MobileCardSkeleton key={i} metaLines={metaLines} hasImage={hasImage} />
      ))}
    </div>
  );
}
