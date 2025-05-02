"use client";

import Link from "next/link";
import { type Ref, useCallback, useState } from "react";
import Tree, { type CustomNodeElementProps, type Point } from "react-d3-tree";
import { api } from "~/trpc/react";

const nodeSize = { x: 100, y: 200 };
const foreignObjectProps: React.SVGProps<SVGForeignObjectElement> = {
  width: nodeSize.x,
  height: nodeSize.y,
  x: 20,
};
const rootName = "_root";
export default function LocationTreeGraph() {
  const locations = api.location.makeTree.useQuery();
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
        setTranslate({ x: width / 2, y: height / 2 });
      }
    },
    [],
  );
  return { translate, containerRef };
};

const renderForeignObjectNode = ({
  nodeDatum,
  toggleNode,
  // foreignObjectProps,
}: CustomNodeElementProps) => (
  <g>
    <circle onClick={toggleNode} r={15}></circle>
    {/* `foreignObject` requires width & height to be explicitly set. */}
    <foreignObject {...foreignObjectProps}>
      <div style={{ border: "1px solid black", backgroundColor: "#dedede" }}>
        <h3 style={{ textAlign: "center" }}>{nodeDatum.name}</h3>
        {nodeDatum.name !== rootName && (
          <>
            <Link
              className="text-blue-600 hover:underline dark:text-blue-500"
              //@ts-expect-error id is a prop
              href={`locations/${nodeDatum.id}`}
            >
              {nodeDatum.name}
            </Link>
            {/* @ts-expect-error type is a prop */}
            <div className="">{nodeDatum.type}</div>
          </>
        )}
      </div>
    </foreignObject>
  </g>
);
