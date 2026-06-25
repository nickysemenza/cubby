import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { ChevronRight, Network } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Row, Stack } from "~/components/layout";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import type { BaseKind } from "~/lib/conversion-coverage";
import { ConversionCapabilities } from "./ConversionCapabilities";
import { UnitMappingsTable } from "./unitmappingstable";

// d3-force is heavy and only matters when the graph is actually expanded, so
// keep it out of the default detail-page bundle — same lazy pattern RecipeDetail
// uses for its charts.
const UnitMappingGraph = lazy(() =>
  import("./unit-mapping-graph").then((m) => ({ default: m.UnitMappingGraph })),
);

/**
 * The one rich unit-mapping surface: coverage chips (big-4 + macros) over a
 * collapsible, lazy-loaded node-link graph and the source-attributed mappings
 * table. Shared by the product/ingredient detail sections, the Convert dialog,
 * and the workbench editor so they read the same model and can't drift.
 */
export function UnitCoveragePanel({
  mappings,
  kinds,
  hideConvertButton = false,
  defaultGraphOpen = false,
}: {
  mappings: UnitMapping[];
  /** Measurement-kind universe to grade against (USDA passes USDA_KINDS). */
  kinds?: readonly BaseKind[];
  hideConvertButton?: boolean;
  /** Start with the graph expanded (the Convert dialog opts in). */
  defaultGraphOpen?: boolean;
}) {
  const [graphOpen, setGraphOpen] = useState(defaultGraphOpen);

  return (
    <Stack gap="sm">
      <ConversionCapabilities
        mappings={mappings}
        kinds={kinds}
        hideConvertButton={hideConvertButton}
      />

      <Collapsible open={graphOpen} onOpenChange={setGraphOpen}>
        <CollapsibleTrigger
          render={
            <Row
              as="button"
              type="button"
              align="center"
              gap="sm"
              className="w-full rounded-md px-2 py-1.5 text-muted-foreground text-sm hover:bg-accent"
            />
          }
        >
          <ChevronRight
            className={`h-4 w-4 transition-transform ${graphOpen ? "rotate-90" : ""}`}
            aria-hidden
          />
          <Network className="h-4 w-4" aria-hidden />
          <span>Conversion graph</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* Guard the mount so d3-force only loads + simulates once expanded. */}
          {graphOpen && (
            <Suspense
              fallback={
                <div className="h-[260px] animate-pulse rounded-md border bg-muted/30" />
              }
            >
              <UnitMappingGraph mappings={mappings} />
            </Suspense>
          )}
        </CollapsibleContent>
      </Collapsible>

      <UnitMappingsTable mappings={mappings} />
    </Stack>
  );
}
