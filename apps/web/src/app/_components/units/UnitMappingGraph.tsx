// https://nextjs.org/docs/pages/building-your-application/optimizing/lazy-loading#with-no-ssr
import dynamic from "next/dynamic";
import { WUnitMapping } from "@recipehub/recipebridge";
import { wasm } from "~/lib/wasm";
import { getErrorMessage } from "~/lib/error-utils";
const Graphviz = dynamic(() => import("graphviz-react"), { ssr: false });

export const UnitMappingGraph: React.FC<{ unitMapping: WUnitMapping[] }> = ({
  unitMapping,
}) => {
  if (unitMapping.length === 0) {
    return (
      <div className="border-destructive text-destructive border-2">
        No unit mappings
      </div>
    );
  }

  // Generate graph outside of JSX to avoid try/catch around JSX
  let graph: string;
  let error: unknown = null;

  try {
    graph = wasm.graph_unit_mappings(unitMapping).replace(
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
  } catch (e) {
    error = e;
  }

  if (error) {
    return <div className="text-destructive">{getErrorMessage(error)}</div>;
  }

  return (
    <div className="overflow-auto rounded border bg-slate-50 p-2">
      <Graphviz
        dot={graph!}
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
