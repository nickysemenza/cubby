/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Nivo forwards this role to SVG; grouping keeps nested links and buttons accessible. */
import type { NodeComponentProps } from "@nivo/tree";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { entityDetailLink } from "~/entity/entities";
import {
  type LocationHierarchyNode,
  useLocationHierarchy,
} from "~/entity/hooks/use-location-hierarchy";
import {
  CATEGORY_HIERARCHY_ROOT_ID,
  type CategoryHierarchyNode,
} from "~/features/product-category/category-tree";
import {
  categoryNodeColor,
  useCategoryHierarchy,
} from "~/features/product-category/use-category-hierarchy";
import { nivoChartTheme, nivoMotion } from "~/lib/nivo-theme";
import { ChartTooltip } from "~/ui/charts/chart-tooltip";
import {
  ResponsiveSunburst,
  ResponsiveTree,
} from "~/ui/charts/nivo-responsive";
import { Grid } from "~/ui/layout";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

export type HierarchyEntity = "location" | "productCategory";

/** One node of any parent-linked entity's rolled-up count tree. */
interface HierarchyNode {
  id: string;
  name: string;
  /** False for a synthetic root that names no real record. */
  linked: boolean;
  /** Items held directly by this node. */
  own: number;
  /** Items held by this node and every descendant. */
  total: number;
  /** Declared ink (a category's feature); depth-ramped when absent. */
  color: string | null;
  children?: HierarchyNode[];
}

const fromCategory = (node: CategoryHierarchyNode): HierarchyNode => ({
  id: node.id,
  name: node.name,
  linked: node.id !== CATEGORY_HIERARCHY_ROOT_ID,
  own: node.directCount,
  total: node.totalCount,
  color:
    node.id === CATEGORY_HIERARCHY_ROOT_ID ? null : categoryNodeColor(node),
  children: node.children?.map(fromCategory),
});

const fromLocation = (node: LocationHierarchyNode): HierarchyNode => ({
  id: node.id,
  name: node.name,
  linked: true,
  own: node.directCount,
  total: node.totalCount,
  color: null,
  children: node.children?.map(fromLocation),
});

const UNIT = { location: "items", productCategory: "products" } as const;

type HierarchyStateProps = {
  entity: HierarchyEntity;
  height: number;
  children: (data: HierarchyNode) => React.ReactNode;
};

/** Each entity's own query, so a page only fetches the tree it shows. */
function HierarchyState(props: HierarchyStateProps) {
  return props.entity === "location" ? (
    <LocationHierarchyState {...props} />
  ) : (
    <CategoryHierarchyState {...props} />
  );
}

function LocationHierarchyState(props: HierarchyStateProps) {
  const query = useLocationHierarchy({ valuationMode: "itemCount" });
  const data = useMemo(
    () => (query.data ? fromLocation(query.data) : null),
    [query.data],
  );
  return <HierarchyResult {...props} {...query} data={data} />;
}

function CategoryHierarchyState(props: HierarchyStateProps) {
  const query = useCategoryHierarchy();
  const data = useMemo(
    () => (query.data ? fromCategory(query.data) : null),
    [query.data],
  );
  return <HierarchyResult {...props} {...query} data={data} />;
}

function HierarchyResult({
  entity,
  height,
  children,
  data,
  isLoading,
  isError,
  error,
  refetch,
}: HierarchyStateProps & {
  data: HierarchyNode | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}) {
  return (
    <Visualization
      state={visualizationState({
        data: data ?? (isLoading || isError ? undefined : null),
        isLoading,
        error: isError ? error : null,
        empty: !data || data.total === 0,
        onRetry: () => void refetch(),
      })}
      message={`No ${UNIT[entity]} to display`}
      height={height}
    >
      {data && children(data)}
    </Visualization>
  );
}

const hierarchyColor = (node: HierarchyNode) => node.color ?? "var(--chart-3)";

interface HierarchyTreeDatum extends HierarchyNode {
  entity: HierarchyEntity;
  children?: HierarchyTreeDatum[];
}

function TreeNode({ node }: NodeComponentProps<HierarchyTreeDatum>) {
  return (
    <g transform={`translate(${node.x}, ${node.y})`}>
      <circle
        r={4.5}
        fill={node.data.total ? hierarchyColor(node.data) : "var(--background)"}
        stroke="var(--muted-foreground)"
      />
      <foreignObject x={8} y={-12} width={180} height={24}>
        <div className="flex h-6 items-center gap-1.5 truncate bg-background/80 pr-1 text-xs">
          {node.data.linked ? (
            <Link
              {...entityDetailLink(node.data.entity, node.data.id)}
              className="truncate font-medium hover:underline"
            >
              {node.data.name}
            </Link>
          ) : (
            <span>{node.data.name}</span>
          )}
          <span className="text-muted-foreground tabular-nums">
            {node.data.total}
          </span>
        </div>
      </foreignObject>
    </g>
  );
}

function treeData(
  node: HierarchyNode,
  entity: HierarchyEntity,
): HierarchyTreeDatum {
  return {
    ...node,
    entity,
    children: node.children?.map((child) => treeData(child, entity)),
  };
}

function countNodes(node: HierarchyNode): number {
  return (
    1 + (node.children?.reduce((sum, child) => sum + countNodes(child), 0) ?? 0)
  );
}

function treeDepth(node: HierarchyNode): number {
  return 1 + Math.max(0, ...(node.children?.map(treeDepth) ?? []));
}

function HierarchyLinks({
  data,
  entity,
}: {
  data: HierarchyNode;
  entity: HierarchyEntity;
}) {
  return (
    <li>
      {data.linked ? (
        <Link
          {...entityDetailLink(entity, data.id)}
          className="inline-flex min-h-11 items-center text-primary hover:underline sm:min-h-0"
        >
          {data.name}
        </Link>
      ) : (
        <span>{data.name}</span>
      )}
      {": "}
      {data.total} {UNIT[entity]}
      {data.children?.length ? (
        <ul className="pl-3">
          {data.children.map((child) => (
            <HierarchyLinks key={child.id} data={child} entity={entity} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TidyTree({
  data,
  entity,
}: {
  data: HierarchyNode;
  entity: HierarchyEntity;
}) {
  const prepared = useMemo(() => treeData(data, entity), [data, entity]);
  // Nivo defaults to a dendrogram, which aligns leaves instead of preserving parent depth.
  return (
    <div className="max-h-[600px] overflow-auto">
      <div
        style={{
          height: Math.max(360, countNodes(data) * 28),
          minWidth: Math.max(640, treeDepth(data) * 200 + 220),
        }}
      >
        <ResponsiveTree
          data={prepared}
          identity="id"
          mode="tree"
          layout="left-to-right"
          margin={{ top: 24, right: 200, bottom: 24, left: 20 }}
          nodeComponent={TreeNode}
          enableLabel={false}
          linkColor="var(--border)"
          theme={nivoChartTheme}
          {...nivoMotion}
          role="group"
          ariaLabel={`${data.name} hierarchy; counts include descendants. Linked nodes open their records.`}
        />
      </div>
    </div>
  );
}

export function HierarchySunburst({ entity }: { entity: HierarchyEntity }) {
  return (
    <HierarchyState entity={entity} height={360}>
      {(data) => <Sunburst data={data} entity={entity} />}
    </HierarchyState>
  );
}

function Sunburst({
  data,
  entity,
}: {
  data: HierarchyNode;
  entity: HierarchyEntity;
}) {
  return (
    <div>
      <div style={{ height: 360 }}>
        <ResponsiveSunburst
          data={data}
          id="id"
          value="own"
          colors={(node) => hierarchyColor(node.data)}
          inheritColorFromParent={false}
          borderWidth={1}
          borderColor="var(--background)"
          enableArcLabels={false}
          theme={nivoChartTheme}
          {...nivoMotion}
          tooltip={(node) => (
            <ChartTooltip>
              {node.data.name}: {node.value} {UNIT[entity]}
            </ChartTooltip>
          )}
        />
      </div>
      <p className="sr-only">
        {data.name}: {data.total} {UNIT[entity]}. Each ring shows a deeper
        level. Expand counts and record links for a text alternative.
      </p>
      <details className="border-t border-border p-2 text-xs">
        <summary className="cursor-pointer">Counts and record links</summary>
        <ul className="max-h-64 overflow-auto py-2">
          <HierarchyLinks data={data} entity={entity} />
        </ul>
      </details>
    </div>
  );
}

export function HierarchyView({ entity }: { entity: HierarchyEntity }) {
  const unit = UNIT[entity];
  return (
    <Grid cols="pair">
      <Visualization
        state={{ status: "ready" }}
        title="Tree"
        description={`Each count includes the ${unit} in every node below it; hollow dots have none. Scroll to explore.`}
      >
        <HierarchyState entity={entity} height={600}>
          {(data) => <TidyTree data={data} entity={entity} />}
        </HierarchyState>
      </Visualization>
      <Visualization
        state={{ status: "ready" }}
        title="Sunburst"
        description={`Rings go one level deeper each, sized by ${unit}.`}
      >
        <HierarchySunburst entity={entity} />
      </Visualization>
    </Grid>
  );
}
