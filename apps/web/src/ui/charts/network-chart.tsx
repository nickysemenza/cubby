/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Nivo forwards this role to SVG; grouping keeps nested links and buttons accessible. */
import type { LinkProps, NodeProps } from "@nivo/network";

import { nivoChartTheme, nivoMotion } from "~/lib/nivo-theme";
import { ChartTooltip } from "~/ui/charts/chart-tooltip";
import { ResponsiveNetwork } from "~/ui/charts/nivo-responsive";

export interface NetworkChartNode {
  id: string;
  label: string;
  color: string;
  size: number;
  selected?: boolean;
  onSelect?: () => void;
}

export interface NetworkChartLink {
  source: string;
  target: string;
  weight?: number;
  native?: boolean;
}

function NetworkNode({
  node,
  onMouseEnter,
  onMouseMove,
  onMouseLeave,
}: NodeProps<NetworkChartNode>) {
  const { label, onSelect, selected } = node.data;
  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      role={onSelect ? "button" : "graphics-symbol"}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={label}
      aria-pressed={onSelect ? Boolean(selected) : undefined}
      onMouseEnter={(event) => onMouseEnter?.(node, event)}
      onMouseMove={(event) => onMouseMove?.(node, event)}
      onMouseLeave={(event) => onMouseLeave?.(node, event)}
      onClick={onSelect}
      onKeyDown={
        onSelect
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
      className={
        onSelect
          ? "cursor-pointer outline-offset-2 focus-visible:outline"
          : undefined
      }
    >
      <title>{label}</title>
      <circle
        r={node.size / 2}
        fill={node.color}
        stroke={selected ? "var(--foreground)" : "var(--background)"}
        strokeWidth={selected ? 3 : 1}
      />
      <text
        y={node.size / 2 + 12}
        textAnchor="middle"
        className="fill-foreground text-2xs"
      >
        {label.length > 22 ? `${label.slice(0, 21)}…` : label}
      </text>
    </g>
  );
}

function NetworkLink({ link }: LinkProps<NetworkChartNode, NetworkChartLink>) {
  return (
    <line
      x1={link.source.x}
      y1={link.source.y}
      x2={link.target.x}
      y2={link.target.y}
      stroke="var(--border)"
      strokeWidth={link.thickness}
      strokeDasharray={link.data.native ? "3 3" : undefined}
    />
  );
}

/** Nivo settles layout synchronously; never stream simulation ticks through React state. */
export function NetworkChart({
  data,
  summary,
  height = 400,
}: {
  data: { nodes: NetworkChartNode[]; links: NetworkChartLink[] };
  summary: string;
  height?: number;
}) {
  return (
    <div style={{ height }}>
      <ResponsiveNetwork
        data={data}
        margin={{ top: 32, right: 64, bottom: 48, left: 64 }}
        iterations={180}
        linkDistance={80}
        repulsivity={300}
        nodeSize={(node) => node.size}
        nodeColor={(node) => node.color}
        linkThickness={(link) => Math.min(5, Math.sqrt(link.data.weight ?? 1))}
        nodeComponent={NetworkNode}
        linkComponent={NetworkLink}
        nodeTooltip={({ node }) => (
          <ChartTooltip>{node.data.label}</ChartTooltip>
        )}
        theme={nivoChartTheme}
        {...nivoMotion}

        role="group"
        ariaLabel={summary}
      />
      <p className="sr-only">{summary}</p>
    </div>
  );
}
