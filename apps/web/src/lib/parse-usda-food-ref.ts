// Parse a pasted USDA food reference into an fdc_id, so the food-search box can
// jump straight to one exact food when name search buries it. Accepts:
//   - a bare numeric id: "384417"
//   - our worker URL:    "https://usda-api.nicky.workers.dev/api/foods/384417"
//   - the FDC detail URL: "https://fdc.nal.usda.gov/food-details/384417/nutrients"
// Returns the id, or null for ordinary text searches (which flow to FTS as before).
//
// Pure + dependency-free on purpose (no `~` aliases): keeps it unit-testable in
// the alias-free "unit" vitest project.
export function parseUsdaFoodRef(input: string): number | null {
  const s = input.trim();
  if (!s) return null;

  // Bare id — require 3+ digits so we don't hijack short numeric searches.
  if (/^\d{3,}$/.test(s)) return Number(s);

  // Only treat it as a reference if it actually looks like a USDA food URL,
  // then pull the id segment out of the known path shapes.
  if (!/foods|food-details|fdc/i.test(s)) return null;
  const match = s.match(/(?:foods|food-details)\/(\d{3,})/i);
  return match ? Number(match[1]) : null;
}
