import type { JsonViewer as JsonViewerComponent } from "json-edit-react";
import { type ComponentProps, type JSX, Suspense } from "react";

import { browserOnlyLazy } from "~/lib/browser-only-lazy";

// Debug surfaces only: json-edit-react loads when a pretty view first renders.
const JsonViewer = browserOnlyLazy<ComponentProps<typeof JsonViewerComponent>>(
  import.meta.env.SSR
    ? null
    : () =>
        import("json-edit-react").then((module) => ({
          default: module.JsonViewer,
        })),
);

const JsonRenderer = ({
  input,
  pretty = false,
}: {
  input: unknown;
  pretty?: boolean;
}): JSX.Element => {
  const plain = (
    <pre className="overflow-auto">{JSON.stringify(input, null, 2)}</pre>
  );
  return pretty ? (
    <Suspense fallback={plain}>
      <JsonViewer data={input} baseFontSize="10px" />
    </Suspense>
  ) : (
    plain
  );
};

export default JsonRenderer;
