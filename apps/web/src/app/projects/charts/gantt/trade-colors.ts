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

type Phase = "planning" | "structure" | "mep" | "surfaces" | "finish" | "site";

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
const PHASE_COLOR: Record<Phase, string> = {
  planning: "var(--phase-planning)",
  structure: "var(--phase-structure)",
  mep: "var(--phase-mep)",
  surfaces: "var(--phase-surfaces)",
  finish: "var(--phase-finish)",
  site: "var(--phase-site)",
};

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
