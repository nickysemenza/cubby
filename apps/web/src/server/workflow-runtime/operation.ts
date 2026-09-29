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
