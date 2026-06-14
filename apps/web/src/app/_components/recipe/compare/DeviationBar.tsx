/**
 * Compact in-cell statistical glyphs for the recipe-comparison grid, drawn with
 * absolutely-positioned divs on a shared per-row scale (no charting lib, and no
 * stretched SVG — percentage-positioned divs keep dots perfectly round at any
 * column width, which a width-stretched SVG viewBox would distort to an ellipse).
 */

/** Clamp v into [lo, hi]. */
const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** Full-width hairline axis with a measured end tick at each bound. */
const Axis: React.FC = () => (
  <>
    <div
      className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2"
      style={{ background: "var(--border)" }}
    />
    <div
      className="absolute top-1/2 left-0 h-1.5 w-px -translate-y-1/2"
      style={{ background: "var(--border)" }}
    />
    <div
      className="absolute top-1/2 right-0 h-1.5 w-px -translate-y-1/2"
      style={{ background: "var(--border)" }}
    />
  </>
);

/**
 * One recipe's value as a dot on the row's shared `[0, max]` axis: a crisp mean
 * rule and a thin whisker from the mean to the dot show both the absolute amount
 * and the direction/size of the deviation. The row's largest deviation takes the
 * brick `--primary` accent; the rest are crisp neutral.
 */
export const StripPlotCell: React.FC<{
  value: number;
  mean: number;
  max: number;
  /** True when this cell is the row's largest deviation. */
  isMax: boolean;
}> = ({ value, mean, max, isMax }) => {
  if (max <= 0) return null;

  const pct = (v: number) => clamp((v / max) * 100, 0, 100);
  const xMean = pct(mean);
  const xVal = pct(value);
  const color = isMax ? "var(--primary)" : "var(--foreground)";

  return (
    <div className="relative mt-1.5 h-2.5 w-full">
      <Axis />
      <div
        className="absolute top-1/2 h-px -translate-y-1/2 opacity-40"
        style={{
          left: `${Math.min(xMean, xVal)}%`,
          width: `${Math.abs(xVal - xMean)}%`,
          background: color,
        }}
      />
      <div
        className="absolute top-0 bottom-0 w-px -translate-x-1/2"
        style={{ left: `${xMean}%`, background: "var(--muted-foreground)" }}
      />
      <div
        className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          left: `${xVal}%`,
          width: isMax ? 7 : 5,
          height: isMax ? 7 : 5,
          background: color,
        }}
      />
    </div>
  );
};

/**
 * A box-and-whisker summary for the Average column: min–max whiskers, a box
 * spanning mean ±1σ, and a bold brick mean tick. Domain is the row's own
 * `[min, max]`, so it reads as the distribution shape regardless of units.
 */
export const DistributionGlyph: React.FC<{
  mean: number;
  min: number;
  max: number;
  std: number;
}> = ({ mean, min, max, std }) => {
  if (max <= min) return null;

  const pct = (v: number) => clamp(((v - min) / (max - min)) * 100, 0, 100);
  const boxL = pct(mean - std);
  const boxR = pct(mean + std);

  return (
    <div className="relative mt-1.5 h-2.5 w-full">
      <div
        className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2"
        style={{ background: "var(--muted-foreground)" }}
      />
      <div
        className="absolute top-1/2 left-0 h-1.5 w-px -translate-y-1/2"
        style={{ background: "var(--muted-foreground)" }}
      />
      <div
        className="absolute top-1/2 right-0 h-1.5 w-px -translate-y-1/2"
        style={{ background: "var(--muted-foreground)" }}
      />
      <div
        className="absolute top-1/2 h-2 -translate-y-1/2 border"
        style={{
          left: `${boxL}%`,
          width: `${Math.max(0, boxR - boxL)}%`,
          background: "var(--card)",
          borderColor: "var(--muted-foreground)",
        }}
      />
      <div
        className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2"
        style={{ left: `${pct(mean)}%`, background: "var(--primary)" }}
      />
    </div>
  );
};
