import type { WUnitMapping } from "@cubby/recipebridge";
import React, { lazy, Suspense, useMemo } from "react";
import { getErrorMessage } from "~/lib/error-utils";
import { wasm } from "~/lib/wasm";

const Graphviz = lazy(() => import("graphviz-react"));

const UnitMappingGraphInner: React.FC<{
  unitMapping: WUnitMapping[];
  compact?: boolean;
}> = ({ unitMapping, compact = false }) => {
  // Memoize the expensive WASM graph generation
  const graphResult = useMemo(() => {
    if (unitMapping.length === 0) {
      return { graph: null, error: null };
    }

    try {
      // Factor rounding, edge collapsing, node `class=<kind>` tagging, and the
      // dashed volume bridge all happen upstream in recipebridge's print_graph.
      // Here we only inject layout/theme: fdp star layout with a loosened spring
      // length (K) and node separation so the hub's spokes fan out instead of
      // collapsing onto the center. Node fills are themed per-kind via CSS
      // (.node.<kind> in styles.css), keyed off the upstream `class` attribute.
      const graph = wasm.graph_unit_mappings(unitMapping).replace(
        "digraph {",
        `digraph {
          layout=fdp;
          overlap=false;
          splines=true;
          K=0.9;
          sep="+18";
          esep="+10";
          bgcolor="transparent";
          node [fontsize=10, fontname="sans-serif", shape=box, style="rounded,filled", fillcolor="#eef0f3", color="#9ca0a8", margin="0.06,0.04"];
          edge [fontsize=7, fontname="sans-serif", color="#888c94", fontcolor="#6b7280", penwidth=1, len=1.6];
        `,
      );
      return { graph, error: null };
    } catch (e) {
      return { graph: null, error: e };
    }
  }, [unitMapping]);

  // No mappings = nothing to visualize (expected for misc items)
  if (unitMapping.length === 0) {
    return null;
  }

  if (graphResult.error) {
    return (
      <div className="text-destructive">
        {getErrorMessage(graphResult.error)}
      </div>
    );
  }

  // After error check, graph is guaranteed to be non-null for non-empty mappings
  if (!graphResult.graph) {
    return null;
  }

  const width = compact ? 100 : 460;
  const height = compact ? 60 : 320;

  return (
    <div className="unit-mapping-graph overflow-auto rounded border bg-muted p-0.5">
      <Suspense fallback={<div style={{ width, height }} />}>
        <Graphviz
          dot={graphResult.graph}
          options={{
            fit: true,
            width,
            height,
            zoom: !compact,
            useWorker: false,
          }}
        />
      </Suspense>
    </div>
  );
};

// Memoize the component to prevent unnecessary re-renders
export const UnitMappingGraph = React.memo(UnitMappingGraphInner);
