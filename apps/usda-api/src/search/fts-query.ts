export function toFtsQuery(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";

  const parts = s
    .split(/\s+/)
    .filter(Boolean)
    .map((p, i, arr) => {
      const term = p.replace(/["']/g, " ").trim();
      if (i === arr.length - 1) return `${term}*`;
      return term;
    });

  return parts.join(" ");
}
