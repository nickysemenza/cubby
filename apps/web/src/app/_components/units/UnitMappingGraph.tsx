// https://nextjs.org/docs/pages/building-your-application/optimizing/lazy-loading#with-no-ssr
import dynamic from "next/dynamic";
import { WUnitMapping } from "recipebridge/pkg/recipebridge";
import { useWasm } from "~/hooks/useWasm";
const Graphviz = dynamic(() => import("graphviz-react"), { ssr: false });

export const UnitMappingGraph: React.FC<{ unitMapping: WUnitMapping[] }> = ({
  unitMapping,
}) => {
  const w = useWasm();

  if (unitMapping.length === 0) {
    return (
      <div className="border-destructive text-destructive border-2">
        No unit mappings
      </div>
    );
  }
  try {
    const graph = w
      .graph_unit_mappings(unitMapping)
      .replace(
        "digraph {",
        `digraph { rankdir=LR; nodesep=0.5;bgcolor="transparent";`,
      );

    return (
      <Graphviz
        dot={graph}
        options={{
          width: 300,
          height: 150,
          background: "transparent",
          useWorker: false,
        }}
        className="w-full"
      />
    );
  } catch (e) {
    console.log({ e });
    return <div className="text-destructive">{JSON.stringify(e)}</div>;
  }
};
