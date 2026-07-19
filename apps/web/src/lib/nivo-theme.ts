// Shared nivo chart styling — the warm-paper-ledger voice: mono ticks/labels
// in the monochrome ink ladder, hairline grid. Kept dependency-free so
// lazy-loaded chart chunks (sunburst/treemap) don't pull in unrelated modules.
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
        fill: "var(--slate)",
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

// Bar chrome shared by the nivo bar charts — hairline outline and square
// corners so bars read as flat printed figures, not stickers. Spread into
// <ResponsiveBar {...nivoBarChrome}>.
export const nivoBarChrome = {
  borderWidth: 1,
  borderColor: "var(--border)",
  borderRadius: 0,
} as const;

const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
});

// Value axis for the currency bar charts. Nivo otherwise emits a tick per
// gridline, and full "$120,000"-style labels collide once the range grows —
// cap the count and use compact "$120K" labels. Spread extra props alongside:
// axisBottom={nivoCurrencyAxis}.
export const nivoCurrencyAxis = {
  tickValues: 5,
  format: (v: number) => compactUsd.format(v),
} as const;
