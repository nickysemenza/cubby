/**
 * Trade -> build-phase colour for task board columns. Porcelain Transit keeps ordinary
 * data surfaces neutral, so 20 trades cannot each get a distinct hue without
 * turning the chart into a rainbow that fights the five domain lines. The
 * trades instead fold into **six muted build-phase families** — enough colour
 * to group structure / MEP / surfaces / finish / site / planning, while the
 * exact trade is carried by its Phosphor glyph (see `TRADE_ICONS` in shared.tsx)
 * and row label.
 *
 * Alias-free (no `~/`) so it can sit under the vitest `unit` project alongside
 * the other pure project helpers.
 */

import { tradeSchema, type Trade } from "@cubby/schemas/project";

type Phase = "planning" | "structure" | "mep" | "surfaces" | "finish" | "site";

/** Which build phase each trade belongs to. */
const TRADE_PHASE = {
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
} satisfies Record<Trade, Phase>;

/** Phase -> its muted `--phase-*` colour token. */
const PHASE_COLOR = {
  planning: "var(--phase-planning)",
  structure: "var(--phase-structure)",
  mep: "var(--phase-mep)",
  surfaces: "var(--phase-surfaces)",
  finish: "var(--phase-finish)",
  site: "var(--phase-site)",
} satisfies Record<Phase, string>;

/** The phase a trade rolls up to, or null for an unknown/absent trade. */
function tradePhase(trade: string | null | undefined): Phase | null {
  const parsed = tradeSchema.safeParse(trade);
  return parsed.success ? TRADE_PHASE[parsed.data] : null;
}

/** Phase colour for a trade, defaulting to neutral when the trade is unknown. */
export function getTradeColor(trade: string | null | undefined): string {
  const phase = tradePhase(trade);
  return phase == null ? "var(--chart-neutral)" : PHASE_COLOR[phase];
}
