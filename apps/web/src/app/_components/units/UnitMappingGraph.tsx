import type { WUnitMapping } from "@recipehub/recipebridge";
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
      const graph = wasm.graph_unit_mappings(unitMapping).replace(
        "digraph {",
        `digraph {
          layout=fdp;
          overlap=false;
          sep="+10";
          bgcolor="transparent";
          node [fontsize=9, fontname="sans-serif", shape=box, style="rounded,filled", fillcolor="#e2e8f0", color="#64748b"];
          edge [fontsize=7, fontname="sans-serif", color="#475569", penwidth=1.2, len=1.2];
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

  const width = compact ? 100 : 220;
  const height = compact ? 60 : 140;

  return (
    <div className="overflow-auto rounded border bg-muted p-0.5">
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
