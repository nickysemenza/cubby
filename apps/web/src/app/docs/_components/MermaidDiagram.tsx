import { useEffect, useState } from "react";

import { getErrorMessage } from "~/lib/error-utils";

let nextDiagramId = 0;

export function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        return mermaid.render(`docs-mermaid-${++nextDiagramId}`, source);
      })
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

  // Prose paragraph styles otherwise outgrow Mermaid's measured label boxes.
  return (
    <figure
      aria-label="Mermaid diagram"
      className="my-4 min-w-0 overflow-x-auto rounded-md border border-border/50 bg-muted/20 p-3 [&_p]:!m-0 [&_p]:!leading-normal [&_p]:!text-inherit"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
