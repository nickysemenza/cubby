import type { WUnitMapping } from "@cubby/recipebridge";
import React, { lazy, Suspense, useMemo } from "react";
import { getErrorMessage } from "~/lib/error-utils";
import { wasm } from "~/lib/wasm";

const Graphviz = lazy(() => import("graphviz-react"));

/**
 * graphviz-react parses the DOT during render, so a malformed graph (e.g. a unit
 * label with a comma like USDA's "cup, diced", which print_graph doesn't escape)
 * throws past the WASM try/catch and would crash the whole route. Contain it: a
 * failed graph degrades to a note instead of taking the page down. Keyed on the
 * dot string upstream so it retries when the graph changes.
 */
// biome-ignore lint/style/useReactFunctionComponents: error boundaries have no hook equivalent
class GraphErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="p-2 text-muted-foreground text-xs">
          Couldn't render the conversion graph.
        </div>
      );
    }
    return this.props.children;
  }
}

const UnitMappingGraphInner: React.FC<{
  unitMapping: WUnitMapping[];
}> = ({ unitMapping }) => {
  // Memoize the expensive WASM graph generation
  const graphResult = useMemo(() => {
    if (unitMapping.length === 0) {
      return { graph: null, error: null };
    }

    try {
      // Factor rounding, edge collapsing, node `class=<kind>` tagging, and the
      // dashed volume bridge all happen upstream in recipebridge's print_graph.
      // Here we inject only structure/layout: an fdp star layout with a loosened
      // spring length (K) and node separation so the hub's spokes fan out instead
      // of collapsing onto the center. All colors are themed via design tokens in
      // CSS (.unit-mapping-graph in styles.css) — node fills keyed off the
      // upstream per-kind `class`, edges/labels via the muted palette — so no
      // hex lives here.
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
          node [fontsize=10, fontname="sans-serif", shape=box, style="rounded,filled", margin="0.06,0.04"];
          edge [fontsize=7, fontname="sans-serif", penwidth=1, len=1.6];
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

  const width = 460;
  const height = 320;

  return (
    <div className="unit-mapping-graph overflow-auto rounded border bg-muted p-0.5">
      <GraphErrorBoundary key={graphResult.graph}>
        <Suspense fallback={<div style={{ width, height }} />}>
          <Graphviz
            dot={graphResult.graph}
            options={{
              fit: true,
              width,
              height,
              zoom: true,
              useWorker: false,
            }}
          />
        </Suspense>
      </GraphErrorBoundary>
    </div>
  );
};

// Memoize the component to prevent unnecessary re-renders
export const UnitMappingGraph = React.memo(UnitMappingGraphInner);
