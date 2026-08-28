/**
 * Shared overlay chrome for visualizations.
 *
 * `VizTooltip` — the absolutely-positioned popover card shown on hover/select.
 * `VizOverlay` — the corner legend/caption card.
 *
 * Absolute positioning is chart-legitimate; only the card chrome is shared.
 * Pass `className` to tweak per-chart position offsets, `max-w-xs`, `border`,
 * etc. Pass `style` for cursor-driven positioning.
 */
import type { CSSProperties, ReactNode } from "react";

import { cn } from "~/lib/utils";

export function VizTooltip({
  children,
  className,
  style,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: optional click prevention for selected-item tooltips
    <div
      className={cn(
        "pointer-events-none absolute top-4 left-4 z-50 bg-popover px-4 py-2 text-sm ring-1 ring-border",
        className,
      )}
      style={style}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

export function VizOverlay({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "absolute right-2 bottom-2 rounded bg-background/80 px-2 py-1 text-xs backdrop-blur",
        className,
      )}
    >
      {children}
    </div>
  );
}
