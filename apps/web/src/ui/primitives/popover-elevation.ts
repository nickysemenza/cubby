import { cn } from "~/lib/utils";

// eslint-disable-next-line cubby/no-shadow-utility -- Only floating menus, pickers, tooltips and dialogs share popover elevation.
export const popoverElevationClassName = cn("shadow-[var(--brand-elevation-popover)]");
