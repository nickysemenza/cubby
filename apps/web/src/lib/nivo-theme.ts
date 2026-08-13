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

/**
 * Nivo animates via react-spring, which interpolates colors by parsing numbers
 * out of each keyframe string — and it cannot parse `oklch()`. Our ramp mixes
 * both formats (`--chart-1` resolves to a hex brand token → 4 rgba numbers;
 * `--chart-2..8` are oklch → 3 numbers), so any chart whose series span the two
 * throws "The arity of each output value must be equal" on every transition.
 *
 * Turning the animation off is the fix rather than a workaround: DESIGN.md asks
 * for flat charts that "favor comparison over spectacle" and motion that is
 * short and mechanical, so a spring-tweened bar was never the intended register.
 * It also keeps the ramp authored in oklch, which is what the contrast math for
 * the slice labels is computed against.
 *
 * Spread into any nivo chart: <ResponsiveLine {...nivoMotion} />.
 */
export const nivoMotion = { animate: false } as const;

// Bar chrome shared by the nivo bar charts — hairline outline and square
// corners so bars read as flat printed figures, not stickers. Carries
// `nivoMotion`. Spread into <ResponsiveBar {...nivoBarChrome}>.
export const nivoBarChrome = {
  borderWidth: 1,
  borderColor: "var(--border)",
  borderRadius: 0,
  ...nivoMotion,
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
