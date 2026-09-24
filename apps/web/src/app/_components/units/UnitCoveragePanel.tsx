import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { UnitMapping, UnitMappingInput } from "@cubby/schemas/unitmapping";
import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { NetworkIcon as Network } from "@phosphor-icons/react/dist/csr/Network";
import { lazy, Suspense, useId, useMemo, useState } from "react";

import { Row, Stack } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Label } from "~/components/ui/label";
import type { BaseKind } from "~/lib/conversion-coverage";
import { wasm } from "~/lib/wasm";

import { ConversionCapabilities } from "./ConversionCapabilities";
import { ServingAliasField } from "./serving-alias-field";
import { UnitPriceLine } from "./unit-price-line";
import { UnitMappingsTable } from "./unitmappingstable";

// d3-force is heavy and only matters when the graph is actually expanded, so
// keep it out of the default detail-page bundle — same lazy pattern RecipeDetail
// uses for its charts.
const UnitMappingGraph = lazy(() =>
  import("./unit-mapping-graph").then((m) => ({ default: m.UnitMappingGraph })),
);

// A mapping is a nutrient edge when either endpoint classifies as `nutrient:*`.
// Detected by unit (the graph's own filter is unit-based), NOT source string, so
// the toggle matches exactly what the graph hides — and stays lazy (no import of
// the d3 module just to count). `amount_kind` is a cheap, cached WASM probe.
const isNutrientUnit = (unit: string): boolean => {
  try {
    return wasm.amount_kind({ value: 1, unit }).startsWith("nutrient:");
  } catch {
    return false;
  }
};

/**
 * The one rich unit-mapping surface: coverage chips (big-4 + macros) over a
 * collapsible, lazy-loaded node-link graph and the source-attributed mappings
 * table. Adopted by product and ingredient detail sections.
 */
export function UnitCoveragePanel({
  mappings,
  kinds,
  hideConvertButton = false,
  defaultGraphOpen = false,
  showCoverage = true,
  servingAlias,
}: {
  mappings: UnitMapping[];
  /** Measurement-kind universe to grade against (USDA passes USDA_KINDS). */
  kinds?: readonly BaseKind[];
  hideConvertButton?: boolean;
  /** Start with the graph expanded (the Convert dialog opts in). */
  defaultGraphOpen?: boolean;
  /**
   * Show the food-coverage capabilities block (big-4/calorie chips + tier).
   * Non-food (household/garage) products pass `false` — food unit coverage
   * (calories, price) is meaningless for them, so only the raw mappings table
   * (if any) and the graph render.
   */
  showCoverage?: boolean;
  /**
   * Opt into the "1 serving = X g" quick-add row. Only a single product owns a
   * concrete `unitMappings` array to append to — an ingredient's mappings
   * aggregate across all its linked products, so ingredient-detail omits this
   * and only product-detail passes it.
   */
  servingAlias?: {
    productId: ProductShortcode;
    storedMappings: UnitMappingInput[];
  };
}) {
  const [graphOpen, setGraphOpen] = useState(defaultGraphOpen);
  const [showNutrients, setShowNutrients] = useState(false);
  const showNutrientsId = useId();

  // Nutrient edges (USDA per-nutrient `100 g = X g protein`, macro labels, …) are
  // hidden from the graph by default — they explode the node count and aren't
  // about convertibility — so offer a toggle when there are any to reveal.
  const nutrientCount = useMemo(
    () =>
      mappings.filter(
        (m) => isNutrientUnit(m.a.unit) || isNutrientUnit(m.b.unit),
      ).length,
    [mappings],
  );

  return (
    <Stack gap="sm">
      <UnitPriceLine mappings={mappings} />

      {showCoverage && (
        <ConversionCapabilities
          mappings={mappings}
          kinds={kinds}
          hideConvertButton={hideConvertButton}
        />
      )}

      <Collapsible open={graphOpen} onOpenChange={setGraphOpen}>
        <CollapsibleTrigger
          render={
            <Row
              as="button"
              type="button"
              align="center"
              gap="sm"
              className="w-full rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
            />
          }
        >
          <ChevronRight
            className={`size-4 transition-transform ${graphOpen ? "rotate-90" : ""}`}
            aria-hidden
          />
          <Network className="size-4" aria-hidden />
          <span>Conversion graph</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* Guard the mount so d3-force only loads + simulates once expanded. */}
          {graphOpen && (
            <Stack gap="sm">
              {nutrientCount > 0 && (
                <Row align="center" gap="sm">
                  <Checkbox
                    id={showNutrientsId}
                    checked={showNutrients}
                    onCheckedChange={(c) => setShowNutrients(c === true)}
                  />
                  <Label htmlFor={showNutrientsId} className="text-sm">
                    Show nutrient mappings ({nutrientCount})
                  </Label>
                </Row>
              )}
              <Suspense
                fallback={
                  <div className="h-[260px] animate-pulse border bg-muted/30" />
                }
              >
                <UnitMappingGraph
                  mappings={mappings}
                  includeNutrients={showNutrients}
                />
              </Suspense>
            </Stack>
          )}
        </CollapsibleContent>
      </Collapsible>

      {servingAlias && (
        <ServingAliasField
          productId={servingAlias.productId}
          storedMappings={servingAlias.storedMappings}
          previewMappings={mappings}
        />
      )}

      <UnitMappingsTable mappings={mappings} kinds={kinds} />
    </Stack>
  );
}
