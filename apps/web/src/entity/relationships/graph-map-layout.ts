import { z } from "zod";

const pointSchema = z.object({ x: z.number(), y: z.number() });
const graphMapRectSchema = pointSchema.extend({
  width: z.number(),
  height: z.number(),
});
export const graphMapLayoutInputSchema = z.object({
  revision: z.number(),
  nodes: z.array(
    z.object({
      id: z.string(),
      anchor: z.string().optional(),
      height: z.number().positive().optional(),
    }),
  ),
  previous: z.record(z.string(), graphMapRectSchema),
});
export const graphMapLayoutOutputSchema = z.object({
  revision: z.number(),
  positions: z.record(z.string(), graphMapRectSchema),
});
export type GraphMapRect = z.infer<typeof graphMapRectSchema>;
export type GraphMapLayoutInput = z.infer<typeof graphMapLayoutInputSchema>;

export const GRAPH_CARD_WIDTH = 224;
export const GRAPH_CARD_HEIGHT = 140;
const WIDTH = GRAPH_CARD_WIDTH;
const HEIGHT = GRAPH_CARD_HEIGHT;
const GAP = 48;

const overlaps = (a: GraphMapRect, b: GraphMapRect) =>
  a.x < b.x + b.width + GAP &&
  a.x + a.width + GAP > b.x &&
  a.y < b.y + b.height + GAP &&
  a.y + a.height + GAP > b.y;

/** Stable radial branches: the focus stays centered and each descendant fans outward from its parent. */
export function placeGraphMap(input: GraphMapLayoutInput) {
  const positions = { ...input.previous };
  const slots = new Map<string, number>();
  const pending = [...input.nodes];
  while (pending.length) {
    const ready = pending.findIndex(
      (node) => !node.anchor || positions[node.anchor],
    );
    const node = pending.splice(Math.max(0, ready), 1)[0]!;
    const anchor = node.anchor ?? "";
    const index = slots.get(anchor) ?? 0;
    slots.set(anchor, index + 1);
    if (positions[node.id]) continue;
    const parent = node.anchor
      ? positions[node.anchor]
      : node.id !== input.nodes[0]?.id
        ? positions[input.nodes[0]?.id ?? ""]
        : undefined;
    const height = node.height ?? HEIGHT;
    if (!parent) {
      positions[node.id] = {
        x: -WIDTH / 2,
        y: -height / 2,
        width: WIDTH,
        height,
      };
      continue;
    }
    const px = parent.x + parent.width / 2;
    const py = parent.y + parent.height / 2;
    const outward = Math.atan2(py, px);
    const angle =
      Math.hypot(px, py) < 1
        ? -Math.PI / 2 + index * Math.PI * (3 - Math.sqrt(5))
        : outward + (((index % 5) - 2) * Math.PI) / 8;
    for (let radius = 1; ; radius += GAP / WIDTH) {
      const rect = {
        x: px + Math.cos(angle) * radius * (WIDTH + GAP) - WIDTH / 2,
        y: py + Math.sin(angle) * radius * (HEIGHT + GAP) - height / 2,
        width: WIDTH,
        height,
      };
      if (Object.values(positions).some((other) => overlaps(rect, other)))
        continue;
      positions[node.id] = rect;
      break;
    }
  }
  return { revision: input.revision, positions };
}
