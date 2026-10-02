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

const WIDTH = 196;
const HEIGHT = 104;
const GAP = 32;

const overlaps = (a: GraphMapRect, b: GraphMapRect) =>
  a.x < b.x + b.width + GAP &&
  a.x + a.width + GAP > b.x &&
  a.y < b.y + b.height + GAP &&
  a.y + a.height + GAP > b.y;

/** New records occupy the nearest free grid slot. Existing coordinates are immutable. */
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
      for (let y = -radius; y <= radius && !placed; y++) {
        for (let x = -radius; x <= radius && !placed; x++) {
          if (Math.max(Math.abs(x), Math.abs(y)) !== radius) continue;
          const rect = {
            x: origin.x + x * (WIDTH + GAP),
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
