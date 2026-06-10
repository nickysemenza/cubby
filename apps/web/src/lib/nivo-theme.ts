// Shared nivo chart styling — the ledger voice: mono ticks/labels in warm
// neutrals, hairline grid. Kept dependency-free so lazy-loaded chart chunks
// (sunburst/treemap) don't pull in unrelated modules.
//
// NOTE: brand tokens are oklch/hex — never wrap them in hsl(var(...)); the
// result is an invalid color and nivo silently falls back to its defaults.
export const nivoChartTheme = {
  text: { fill: "var(--foreground)", fontFamily: "var(--font-mono)" },
  axis: {
    ticks: {
      text: {
        fill: "var(--muted-foreground)",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
      },
    },
    legend: {
      text: {
        fill: "var(--eyebrow)",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
      },
    },
  },
  grid: {
    line: { stroke: "var(--border)", strokeWidth: 1 },
  },
  crosshair: {
    line: { stroke: "var(--muted-foreground)", strokeWidth: 1 },
  },
  legends: {
    text: {
      fill: "var(--muted-foreground)",
      fontSize: 10,
      fontFamily: "var(--font-mono)",
    },
  },
};

// Chunky bar chrome shared by the nivo bar charts — soft brown outline like
// the mockup's bordered bars. Spread into <ResponsiveBar {...nivoBarChrome}>.
export const nivoBarChrome = {
  borderWidth: 1.5,
  borderColor: "var(--border-chunky)",
  borderRadius: 3,
} as const;
