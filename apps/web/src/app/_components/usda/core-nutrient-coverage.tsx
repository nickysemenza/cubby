import { Row } from "~/components/layout";
import { CORE_NUTRIENTS } from "~/lib/usda-food-stats";
import { cn } from "~/lib/utils";

/**
 * A compact lit/dim coverage row for the core nutrients (Cal · P · C · Na),
 * mirroring the unit-mappings coverage icons. A badge is lit when the food has a
 * datum for that nutrient (0 counts as present), dim+dashed when absent. Uses
 * short labels rather than pictorial icons — sodium has no clean glyph, and
 * labels stay legible at a glance.
 */
export function CoreNutrientCoverage({
  nutrients,
}: {
  nutrients: Record<string, number>;
}) {
  return (
    <Row wrap gap="xs">
      {CORE_NUTRIENTS.map((n) => {
        const present = nutrients[n.code] !== undefined;
        return (
          <span
            key={n.code}
            title={`${n.name}: ${present ? "has data" : "no data"}`}
            className={cn(
              "border px-1.5 py-0.5 font-mono text-2xs" /* tight: dense nutrient-coverage badge */,
              present
                ? "border-border text-foreground"
                : "border-border/40 border-dashed text-muted-foreground/40",
            )}
          >
            {n.short}
          </span>
        );
      })}
    </Row>
  );
}
