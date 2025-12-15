"use client";
import Link from "next/link";
import { type Ref, useCallback, useState } from "react";
import Tree, {
  type CustomNodeElementProps,
  type Point,
  type RawNodeDatum,
} from "react-d3-tree";
import { useTRPC } from "~/trpc/react";

import { useQuery } from "@tanstack/react-query";
import { LocationId } from "~/schemas/identifiers";
import { LocationType } from "~/schemas/location";

/** Extended node type that includes location-specific properties */
interface LocationNodeDatum extends RawNodeDatum {
  id: LocationId;
  type: LocationType;
}

const nodeSize = { x: 100, y: 200 };
const foreignObjectProps: React.SVGProps<SVGForeignObjectElement> = {
  width: nodeSize.x,
  height: nodeSize.y,
  x: 20,
};
const rootName = "_root";
export default function LocationTreeGraph() {
  const api = useTRPC();
  const locations = useQuery(api.location.makeTree.queryOptions());
  const data = locations.data;
  const { translate, containerRef } = useCenteredTree();

  return (
    data && (
      <div
        id="treeWrapper"
        className="h-[500px] w-full border-2 border-black"
        ref={containerRef}
      >
        <Tree
          data={{ children: data, name: rootName }}
          orientation="vertical"
          translate={translate}
          zoom={0.5}
          renderCustomNodeElement={(rd3tProps) =>
            renderForeignObjectNode({
              ...rd3tProps,
              // foreignObjectProps,
            })
          }
        />
      </div>
    )
  );
}
// cf https://github.com/bkrem/react-d3-tree/issues/394#issuecomment-1150687311
const useCenteredTree = () => {
  const [translate, setTranslate] = useState<Point>({ x: 0, y: 0 });
  const containerRef: Ref<HTMLElement> = useCallback(
    (containerElem: HTMLElement) => {
      if (containerElem !== null) {
        const { width, height } = containerElem.getBoundingClientRect();
        setTranslate({ x: width / 2, y: height / 4 });
      }
    },
    [],
  );
  return { translate, containerRef };
};

const renderForeignObjectNode = ({
  nodeDatum,
  toggleNode,
}: CustomNodeElementProps) => {
  const locationNode = nodeDatum as unknown as LocationNodeDatum;
  return (
    <g>
      <circle onClick={toggleNode} r={15}></circle>
      {/* `foreignObject` requires width & height to be explicitly set. */}
      <foreignObject {...foreignObjectProps}>
        <div style={{ border: "1px solid black", backgroundColor: "#dedede" }}>
          <h3 style={{ textAlign: "center" }}>{locationNode.name}</h3>
          {locationNode.name !== rootName && (
            <>
              <Link
                className="text-primary hover:underline"
                href={`locations/${locationNode.id}`}
              >
                {locationNode.name}
              </Link>
              <div>{locationNode.type}</div>
            </>
          )}
        </div>
      </foreignObject>
    </g>
  );
};
