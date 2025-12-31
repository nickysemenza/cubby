/**
 * Format bytes to human-readable string using Intl.NumberFormat
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 bytes";

  const units = [
    "byte",
    "kilobyte",
    "megabyte",
    "gigabyte",
    "terabyte",
  ] as const;
  const k = 1024;
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    units.length - 1,
  );

  return new Intl.NumberFormat("en-US", {
    style: "unit",
    unit: units[i],
    maximumFractionDigits: decimals,
    unitDisplay: "short",
  }).format(bytes / k ** i);
}
