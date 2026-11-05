import type { ComponentProps } from "react";

import { RemoveButton } from "~/ui/forms/remove-button";

export function TileOverlay({
  count,
  remove,
}: {
  count?: number;
  remove?: ComponentProps<typeof RemoveButton>;
}) {
  return (
    <>
      {count != null && count > 0 && (
        <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 font-mono text-2xs text-white tabular-nums">
          +{count}
        </span>
      )}
      {remove && (
        <RemoveButton
          {...remove}
          className="absolute top-1 right-1 z-20 bg-background text-muted-foreground"
        />
      )}
    </>
  );
}
