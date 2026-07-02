import { type ActionItem, actionsForSurface } from "../actions/action-items";

/**
 * Command-palette quick actions — the `palette-quick` slice of the canonical
 * action registry. Kept as a stable exported array so command-menu can dedupe
 * its "Go to" leaves against these paths without the navbar-only create actions
 * doubling up.
 */
export type QuickAction = ActionItem;

export const quickActions: QuickAction[] = actionsForSurface("palette-quick");
