import { instance } from "@viz-js/viz";

import { packGraphSvgs } from "./dependency-graph-packing";

self.addEventListener(
  "message",
  async (event: MessageEvent<{ dot: string; componentDots?: string[] }>) => {
    try {
      const viz = await instance();
      const { dot, componentDots } = event.data;
      const svg =
        componentDots && componentDots.length > 1
          ? packGraphSvgs(
              componentDots.map((component) =>
                viz.renderString(component, { format: "svg" }),
              ),
            )
          : viz.renderString(dot, { format: "svg" });
      self.postMessage({ svg }, { transfer: [] });
    } catch {
      self.postMessage(
        {
          error:
            "Graph layout could not load. Use the record and relationship list below or retry.",
        },
        { transfer: [] },
      );
    }
  },
);
