/**
 * Trade -> build-phase colour for the Gantt. The Warm-Paper Ledger palette is
 * deliberately monochrome (one ultramarine accent + a grey ramp), so 20 trades
 * can't each get a distinct hue without turning the chart into a rainbow that
 * fights the rest of the app. Instead the trades fold into **six build-phase
 * families**, each with one muted `--phase-*` token — enough colour to group a
 * plan into structure / MEP / surfaces / finish / site / planning, while the
 * exact trade is carried by its Lucide glyph (see `TRADE_ICONS` in shared.tsx)
 * and the row label.
 *
 * Alias-free (no `~/`) so it can sit under the vitest `unit` project alongside
 * the other gantt logic.
 */

import type { Trade } from "@cubby/schemas/project";

export type Phase =
  | "planning"
  | "structure"
  | "mep"
  | "surfaces"
  | "finish"
  | "site";

/** Which build phase each trade belongs to. */
const TRADE_PHASE: Record<Trade, Phase> = {
  planning: "planning",
  demolition: "structure",
  building: "structure",
  drywall: "structure",
  electrical: "mep",
  plumbing: "mep",
  mechanical: "mep",
  cabinetry: "surfaces",
  countertop: "surfaces",
  flooring: "surfaces",
  millwork: "surfaces",
  finishes: "finish",
  appliances: "finish",
  landscaping: "site",
  logistics: "site",
  metalworking: "site",
  crafts: "site",
  auto: "site",
  other: "site",
};

/** Phase -> its muted `--phase-*` colour token. */
export const PHASE_COLOR: Record<Phase, string> = {
  planning: "var(--phase-planning)",
  structure: "var(--phase-structure)",
  mep: "var(--phase-mep)",
  surfaces: "var(--phase-surfaces)",
  finish: "var(--phase-finish)",
  site: "var(--phase-site)",
};

/** Human label for each phase family — for the legend. */
export const PHASE_LABEL: Record<Phase, string> = {
  planning: "Planning",
  structure: "Structure",
  mep: "Mechanical / Electrical / Plumbing",
  surfaces: "Surfaces",
  finish: "Finish",
  site: "Site & specialty",
};

/** Canonical phase order — legend + any phase iteration. */
const PHASE_ORDER: readonly Phase[] = [
  "planning",
  "structure",
  "mep",
  "surfaces",
  "finish",
  "site",
];

/** The phase a trade rolls up to, or null for an unknown/absent trade. */
function tradePhase(trade: string | null | undefined): Phase | null {
  if (trade != null && trade in TRADE_PHASE) return TRADE_PHASE[trade as Trade];
  return null;
}

/** Phase colour for a trade, defaulting to neutral when the trade is unknown. */
export function getTradeColor(trade: string | null | undefined): string {
  const phase = tradePhase(trade);
  return phase == null ? "var(--chart-neutral)" : PHASE_COLOR[phase];
}

/**
 * The distinct phases present across `trades`, in canonical order — for a
 * legend that only lists phases actually on the chart.
 */
export function presentPhases(
  trades: Iterable<string | null | undefined>,
): Phase[] {
  const seen = new Set<Phase>();
  for (const t of trades) {
    const phase = tradePhase(t);
    if (phase != null) seen.add(phase);
  }
  return PHASE_ORDER.filter((p) => seen.has(p));
}
