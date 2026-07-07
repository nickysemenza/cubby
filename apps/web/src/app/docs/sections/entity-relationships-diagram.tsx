/**
 * Hand-authored static SVG of cubby's core entity relationships. Replaces the
 * old graphviz-react render (a lazy-loaded WASM layout engine) with a small,
 * dependency-free diagram whose colors are design tokens so it tracks the
 * light/dark theme. Layout mirrors graphviz's top-to-bottom rank order:
 *   rank 0: Recipe, Inventory   (sources — nothing points at them)
 *   rank 1: Product, Location   (Inventory feeds both)
 *   rank 2: Ingredient, USDA    (fulfilled / enriched leaves)
 */

const NODE_W = 130;
const NODE_H = 44;

type NodeSpec = {
  label: string;
  cx: number;
  cy: number;
  /** Design-token color used for the tinted fill + border. */
  color: string;
  /** Optional/external node — rendered with a dashed border. */
  dashed?: boolean;
};

const NODES: NodeSpec[] = [
  { label: "Recipe", cx: 115, cy: 48, color: "var(--plum)" },
  { label: "Inventory", cx: 520, cy: 48, color: "var(--slate)" },
  { label: "Product", cx: 380, cy: 150, color: "var(--primary)" },
  { label: "Location", cx: 560, cy: 150, color: "var(--warning)" },
  { label: "Ingredient", cx: 200, cy: 252, color: "var(--positive)" },
  {
    label: "USDA Food",
    cx: 445,
    cy: 252,
    color: "var(--muted-foreground)",
    dashed: true,
  },
];

type EdgeSpec = {
  from: [number, number];
  to: [number, number];
  label: string;
  labelAt: [number, number];
  labelAnchor?: "start" | "middle";
  dashed?: boolean;
};

const EDGES: EdgeSpec[] = [
  {
    from: [140, 70],
    to: [185, 228],
    label: "contains",
    labelAt: [150, 150],
  },
  {
    from: [315, 162],
    to: [250, 228],
    label: "fulfills",
    labelAt: [268, 196],
  },
  {
    from: [400, 172],
    to: [438, 228],
    label: "nutrition",
    labelAt: [432, 200],
    dashed: true,
  },
  {
    from: [488, 70],
    to: [408, 126],
    label: "quantity of",
    labelAt: [470, 96],
  },
  {
    from: [548, 70],
    to: [558, 126],
    label: "stored in",
    labelAt: [566, 98],
    labelAnchor: "start",
  },
];

// Location → Location self-loop ("nested in"), drawn on the right edge.
const SELF_LOOP_PATH = "M 625 142 C 672 138 672 162 625 158";

function EdgeLabel({
  label,
  at,
  anchor = "middle",
}: {
  label: string;
  at: [number, number];
  anchor?: "start" | "middle";
}) {
  const [x, y] = at;
  const width = label.length * 6 + 8;
  const rectX = anchor === "start" ? x - 4 : x - width / 2;
  return (
    <>
      <rect
        x={rectX}
        y={y - 8}
        width={width}
        height={16}
        rx={3}
        fill="var(--card)"
      />
      <text
        x={x}
        y={y}
        textAnchor={anchor}
        dominantBaseline="central"
        fontSize={10}
        fill="var(--muted-foreground)"
      >
        {label}
      </text>
    </>
  );
}

export function EntityRelationshipsDiagram() {
  return (
    <svg
      viewBox="0 0 700 300"
      width="100%"
      role="img"
      aria-label="Diagram of cubby's core entity relationships: Recipe contains Ingredient; Product fulfills Ingredient and links to USDA Food for nutrition; Inventory is a quantity of a Product stored in a Location; Locations nest within Locations."
      style={{ maxWidth: "100%", height: "auto" }}
    >
      <defs>
        <marker
          id="er-arrow"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={7}
          markerHeight={7}
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" />
        </marker>
      </defs>

      {/* Edges (drawn first so nodes sit on top of the line ends) */}
      {EDGES.map((edge) => (
        <line
          key={edge.label}
          x1={edge.from[0]}
          y1={edge.from[1]}
          x2={edge.to[0]}
          y2={edge.to[1]}
          stroke="var(--muted-foreground)"
          strokeWidth={1.5}
          strokeDasharray={edge.dashed ? "4 3" : undefined}
          markerEnd="url(#er-arrow)"
        />
      ))}
      <path
        d={SELF_LOOP_PATH}
        fill="none"
        stroke="var(--muted-foreground)"
        strokeWidth={1.5}
        strokeDasharray="4 3"
        markerEnd="url(#er-arrow)"
      />

      {/* Edge labels */}
      {EDGES.map((edge) => (
        <EdgeLabel
          key={`${edge.label}-label`}
          label={edge.label}
          at={edge.labelAt}
          anchor={edge.labelAnchor}
        />
      ))}
      <EdgeLabel label="nested in" at={[632, 133]} anchor="start" />

      {/* Nodes */}
      {NODES.map((node) => (
        <g key={node.label}>
          <rect
            x={node.cx - NODE_W / 2}
            y={node.cy - NODE_H / 2}
            width={NODE_W}
            height={NODE_H}
            rx={8}
            fill={node.color}
            fillOpacity={0.12}
            stroke={node.color}
            strokeWidth={1.5}
            strokeDasharray={node.dashed ? "4 3" : undefined}
          />
          <text
            x={node.cx}
            y={node.cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={13}
            fontWeight={500}
            fill="var(--foreground)"
          >
            {node.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
