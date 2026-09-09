import { instance } from "@viz-js/viz";

self.addEventListener("message", async (event: MessageEvent<string>) => {
  try {
    const viz = await instance();
    self.postMessage(
      { svg: viz.renderString(event.data, { format: "svg" }) },
      { transfer: [] },
    );
  } catch {
    self.postMessage(
      {
        error:
          "Graph layout could not load. Use the record and relationship list below or retry.",
      },
      { transfer: [] },
    );
  }
});
