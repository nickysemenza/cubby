import type { SpanAttr } from "@cubby/worker-tracing";

import { withTrace } from "~/server/tracing";

import type { WorkflowDefinition } from "./definition";
import { executeWorkflow } from "./execute";

/** Bind a definition to `(context, input)` without hiding its executable graph.
 * A definition is worth keeping only where a committed step must precede
 * post-commit effects or several steps carry real structure; a one-step
 * operation is a plain function. */
export function bindWorkflow<Context, Input, Output>(
  definition: WorkflowDefinition<Context, Input, Output>,
) {
  return Object.assign(
    (context: Context, input: Input) =>
      executeWorkflow(definition, { context, input }),
    { definition },
  );
}

/**
 * {@link bindWorkflow} under a named span. `attrs(input)` describes the request
 * when the span opens and `attrs(input, output)` adds the outcome once the
 * workflow settles, so a trace carries both without the caller wiring spans.
 */
export function tracedWorkflow<Context, Input, Output>(options: {
  name: string;
  definition: WorkflowDefinition<Context, Input, Output>;
  attrs?: (input: Input, output?: Output) => Record<string, SpanAttr>;
}) {
  const { name, definition, attrs } = options;
  return Object.assign(
    (context: Context, input: Input) =>
      withTrace(name, async (span) => {
        if (attrs) span.setAttributes(attrs(input));
        const output = await executeWorkflow(definition, { context, input });
        if (attrs) span.setAttributes(attrs(input, output));
        return output;
      }),
    { definition },
  );
}
