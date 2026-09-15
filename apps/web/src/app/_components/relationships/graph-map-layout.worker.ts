import { graphMapLayoutInputSchema, placeGraphMap } from "./graph-map-layout";

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const input = graphMapLayoutInputSchema.safeParse(event.data);
  if (input.success)
    self.postMessage(placeGraphMap(input.data), { transfer: [] });
});
