function formatMs(value: number | null): string {
  if (value == null) return "";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatDate(value: Date | null): string {
  return value ? value.toLocaleString() : "";
}

export { formatDate, formatMs };
