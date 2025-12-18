"use client";
import { type Ref, useCallback, useState } from "react";
import Tree, {
  type CustomNodeElementProps,
  type Point,
  type RawNodeDatum,
} from "react-d3-tree";
import { useTRPC } from "~/trpc/react";

import { useQuery } from "@tanstack/react-query";
import { LocationPillLinkCompact } from "~/app/_components/EntityPill";
import { LocationId } from "~/schemas/identifiers";
import { LocationType } from "~/schemas/location";

/** Extended node type that includes location-specific properties */
interface LocationNodeDatum extends RawNodeDatum {
  id: LocationId;
  type: LocationType;
}

const nodeSize = { x: 200, y: 50 };
const foreignObjectProps: React.SVGProps<SVGForeignObjectElement> = {
  width: nodeSize.x,
  height: nodeSize.y,
  x: 20,
  y: -10,
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
        className="h-125 w-full border-2 border-black"
        ref={containerRef}
      >
        <Tree
          data={{ children: data, name: rootName }}
          orientation="horizontal"
          translate={translate}
          zoom={0.5}
          nodeSize={{ x: 40, y: 150 }}
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
        const { height } = containerElem.getBoundingClientRect();
        setTranslate({ x: 50, y: height / 2 });
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
        {locationNode.name !== rootName ? (
          <LocationPillLinkCompact
            location={{
              name: locationNode.name,
              id: locationNode.id,
              type: locationNode.type,
            }}
          />
        ) : null}
      </foreignObject>
    </g>
  );
};
