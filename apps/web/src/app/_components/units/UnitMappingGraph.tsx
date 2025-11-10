// https://nextjs.org/docs/pages/building-your-application/optimizing/lazy-loading#with-no-ssr
import dynamic from "next/dynamic";
import { WUnitMapping } from "@recipehub/recipebridge";
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

  // Generate graph outside of JSX to avoid try/catch around JSX
  let graph: string;
  let error: unknown = null;

  try {
    graph = w
      .graph_unit_mappings(unitMapping)
      .replace(
        "digraph {",
        `digraph { rankdir=LR; nodesep=0.5;bgcolor="transparent";`,
      );
  } catch (e) {
    error = e;
    console.log({ e });
  }

  if (error) {
    return <div className="text-destructive">{JSON.stringify(error)}</div>;
  }

  return (
    <Graphviz
      dot={graph!}
      options={{
        width: 300,
        height: 150,
        background: "transparent",
        useWorker: false,
      }}
      className="w-full"
    />
  );
};
