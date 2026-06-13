/**
 * A compact in-cell bar showing how one recipe's value deviates from the row
 * average: a center baseline tick with a fill extending right (above average)
 * or left (below average), its width proportional to the deviation. The row's
 * largest deviation is washed in the warm `--warning` token (the poster's
 * orange "biggest deviation" marker); the rest are a soft neutral.
 */
export const DeviationBar: React.FC<{
  value: number;
  average: number;
  /** The largest absolute deviation in this row, used to scale bar widths. */
  maxAbsDeviation: number;
  /** True when this cell is the row's largest deviation. */
  isMax: boolean;
}> = ({ value, average, maxAbsDeviation, isMax }) => {
  if (maxAbsDeviation <= 0) return null;

  const dev = value - average;
  const frac = Math.min(1, Math.abs(dev) / maxAbsDeviation);
  // Half-width: bars grow from the center line, so a full deviation fills 50%.
  const width = `${frac * 50}%`;
  const side = dev >= 0 ? { left: "50%" } : { right: "50%" };

  return (
    <div className="relative mt-1 h-1.5 rounded-sm bg-muted">
      <div className="absolute top-[-1px] bottom-[-1px] left-1/2 w-px -translate-x-1/2 bg-border" />
      <div
        className={`absolute top-0 bottom-0 rounded-sm ${isMax ? "" : "opacity-40"}`}
        style={{
          ...side,
          width,
          backgroundColor: isMax ? "var(--warning)" : "var(--foreground)",
        }}
      />
    </div>
  );
};
