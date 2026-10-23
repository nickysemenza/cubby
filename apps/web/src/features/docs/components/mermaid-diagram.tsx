import { getErrorMessage } from "@cubby/shared";
import { useEffect, useState } from "react";

import { Panel } from "~/ui/layout/panel";

let nextDiagramId = 0;

export function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    // Diagram rendering is browser-only; exclude its engine from Worker uploads.
    if (import.meta.env.SSR) return;
    let active = true;

    void import("pele")
      .then(({ render }) =>
        render(source, { idPrefix: `docs-mermaid-${++nextDiagramId}` }),
      )
      .then(({ svg: renderedSvg }) => {
        if (active) setSvg(renderedSvg);
      })
      .catch((reason) => {
        if (active) setError(getErrorMessage(reason));
      });

    return () => {
      active = false;
    };
  }, [source]);

  if (error) {
    return (
      <div role="alert">
        <p>Could not render Mermaid diagram: {error}</p>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  if (!svg) return <output>Rendering diagram…</output>;

  return (
    <Panel
      tone="muted"
      render={<figure />}
      aria-label="Mermaid diagram"
      className="my-4 overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
