import type { NutritionInfo } from "@cubby/usda-schemas";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { TreeViewIcon } from "@phosphor-icons/react/dist/csr/TreeView";
import { useState } from "react";

import { Row } from "~/components/layout";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";

import { NutritionInfoTable } from "../usda/nutrition";

/**
 * `NutritionLabel` renders only the 22 TIER1_NUTRIENTS; `nutrientSummary` is
 * the full, unbounded USDA nutrient join (B-vitamin variants, fatty-acid
 * breakdowns, amino acids, sugars) that a straight swap to the FDA-style
 * label would silently drop. This keeps the raw table reachable — collapsed
 * by default so it doesn't compete with the label for first-paint attention,
 * expanded on demand for the full breakdown.
 */
export function FullNutrientBreakdown({
  nutritionInfo,
}: {
  nutritionInfo: NutritionInfo;
}) {
  const [open, setOpen] = useState(false);

  if (nutritionInfo.nutrientSummary.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
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
        <CaretRightIcon
          className={`size-4 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        <TreeViewIcon className="size-4" aria-hidden />
        <span>Full nutrient breakdown</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <NutritionInfoTable n={nutritionInfo} />
      </CollapsibleContent>
    </Collapsible>
  );
}
