import { z } from "zod";

const pointSchema = z.object({ x: z.number(), y: z.number() });
const graphMapRectSchema = pointSchema.extend({
  width: z.number(),
  height: z.number(),
});
export const graphMapLayoutInputSchema = z.object({
  revision: z.number(),
  nodes: z.array(z.object({ id: z.string(), anchor: z.string().optional() })),
  previous: z.record(z.string(), graphMapRectSchema),
});
export const graphMapLayoutOutputSchema = z.object({
  revision: z.number(),
  positions: z.record(z.string(), graphMapRectSchema),
});
export type GraphMapRect = z.infer<typeof graphMapRectSchema>;
export type GraphMapLayoutInput = z.infer<typeof graphMapLayoutInputSchema>;

export const GRAPH_CARD_WIDTH = 280;
export const GRAPH_CARD_HEIGHT = 360;
const WIDTH = GRAPH_CARD_WIDTH;
const HEIGHT = GRAPH_CARD_HEIGHT;
const GAP = 48;

const overlaps = (a: GraphMapRect, b: GraphMapRect) =>
  a.x < b.x + b.width + GAP &&
  a.x + a.width + GAP > b.x &&
  a.y < b.y + b.height + GAP &&
  a.y + a.height + GAP > b.y;

/** New records occupy a free column slot to the right of their parent. Existing coordinates are immutable. */
export function placeGraphMap(input: GraphMapLayoutInput) {
  const positions = { ...input.previous };
  const buckets = new Map<string, GraphMapRect[]>();
  const cells = (rect: GraphMapRect) => {
    const keys: string[] = [];
    for (
      let y = Math.floor(rect.y / (HEIGHT + GAP));
      y < Math.ceil((rect.y + rect.height + GAP) / (HEIGHT + GAP));
      y++
    ) {
      for (
        let x = Math.floor(rect.x / (WIDTH + GAP));
        x < Math.ceil((rect.x + rect.width + GAP) / (WIDTH + GAP));
        x++
      )
        keys.push(`${x}:${y}`);
    }
    return keys;
  };
  const insert = (rect: GraphMapRect) => {
    for (const key of cells(rect)) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(rect);
      else buckets.set(key, [rect]);
    }
  };
  for (const rect of Object.values(positions)) insert(rect);
  for (const node of input.nodes) {
    if (positions[node.id]) continue;
    const parent = node.anchor ? positions[node.anchor] : undefined;
    const origin = {
      x: parent ? parent.x + WIDTH + GAP : 0,
      y: parent?.y ?? 0,
    };
    let placed = false;
    for (let radius = 0; !placed; radius++) {
      for (const y of radius === 0 ? [0] : [radius, -radius]) {
        if (placed) break;
        {
          const rect = {
            x: origin.x,
            y: origin.y + y * (HEIGHT + GAP),
            width: WIDTH,
            height: HEIGHT,
          };
          if (
            cells(rect).some((key) =>
              buckets.get(key)?.some((other) => overlaps(rect, other)),
            )
          )
            continue;
          positions[node.id] = rect;
          insert(rect);
          placed = true;
        }
      }
    }
  }
  return { revision: input.revision, positions };
}
