import type { ResponsiveBar as NivoResponsiveBar } from "@nivo/bar";
import type { ResponsiveLine as NivoResponsiveLine } from "@nivo/line";
import type { ResponsivePie as NivoResponsivePie } from "@nivo/pie";
import type { ComponentType } from "react";

import { browserOnlyLazy } from "~/lib/browser-only-lazy";

// nivo's responsive charts measure their container before drawing anything,
// so on the server they render only an empty full-size box. Rendering that box
// here keeps the server HTML the same while ~800 KB of charting code (nivo,
// d3, react-spring) stays out of the Worker.
function ChartBox() {
  return <div style={{ width: "100%", height: "100%" }} />;
}

/**
 * Wrap one nivo responsive chart. The loader must keep its
 * `import.meta.env.SSR ? null : …` guard at the call site so the Worker build
 * drops the import.
 */
function browserOnlyChart<Chart>(
  load: (() => Promise<{ default: ComponentType<object> }>) | null,
): Chart {
  // SAFETY: the wrapper forwards props unchanged to the chart `load` resolves,
  // whose real (generic) signature is `Chart`; `browserOnlyLazy` only erases it.
  return browserOnlyLazy(load, ChartBox) as Chart;
}

export const ResponsiveBar = browserOnlyChart<typeof NivoResponsiveBar>(
  import.meta.env.SSR
    ? null
    : () =>
        import("@nivo/bar").then((m) => ({
          // SAFETY: props reach it unchanged from the typed export below.
          default: m.ResponsiveBar as ComponentType<object>,
        })),
);

export const ResponsiveLine = browserOnlyChart<typeof NivoResponsiveLine>(
  import.meta.env.SSR
    ? null
    : () =>
        import("@nivo/line").then((m) => ({
          // SAFETY: props reach it unchanged from the typed export below.
          default: m.ResponsiveLine as ComponentType<object>,
        })),
);

export const ResponsivePie = browserOnlyChart<typeof NivoResponsivePie>(
  import.meta.env.SSR
    ? null
    : () =>
        import("@nivo/pie").then((m) => ({
          // SAFETY: props reach it unchanged from the typed export below.
          default: m.ResponsivePie as ComponentType<object>,
        })),
);
