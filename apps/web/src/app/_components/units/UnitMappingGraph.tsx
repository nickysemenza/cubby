// https://nextjs.org/docs/pages/building-your-application/optimizing/lazy-loading#with-no-ssr
import React, { useMemo } from "react";
import dynamic from "next/dynamic";
import { WUnitMapping } from "@recipehub/recipebridge";
import { wasm } from "~/lib/wasm";
import { getErrorMessage } from "~/lib/error-utils";

const Graphviz = dynamic(() => import("graphviz-react"), { ssr: false });

const UnitMappingGraphInner: React.FC<{ unitMapping: WUnitMapping[] }> = ({
  unitMapping,
}) => {
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
          node [fontsize=11, fontname="sans-serif", shape=box, style="rounded,filled", fillcolor="#e2e8f0", color="#64748b"];
          edge [fontsize=9, fontname="sans-serif", color="#475569", penwidth=1.5, len=1.5];
        `,
      );
      return { graph, error: null };
    } catch (e) {
      return { graph: null, error: e };
    }
  }, [unitMapping]);

  if (unitMapping.length === 0) {
    return (
      <div className="border-destructive text-destructive border-2">
        No unit mappings
      </div>
    );
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

  return (
    <div className="overflow-auto rounded border bg-slate-50 p-2">
      <Graphviz
        dot={graphResult.graph}
        options={{
          fit: true,
          width: 380,
          height: 280,
          zoom: true,
          useWorker: false,
        }}
      />
    </div>
  );
};

// Memoize the component to prevent unnecessary re-renders
export const UnitMappingGraph = React.memo(UnitMappingGraphInner);
