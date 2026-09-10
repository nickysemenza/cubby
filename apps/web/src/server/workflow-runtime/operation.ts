import { withTrace } from "~/server/tracing";

import type {
  WorkflowDefinition,
  WorkflowOperationDefinition,
} from "./definition";
import { executeWorkflow, type WorkflowExecutionOptions } from "./execute";

/** A one-function operation executes directly. Its identity remains available
 * to the workflow inspector without lowering the function into a graph node.
 * Args are server-only execution arguments, never a transport schema. */
export function defineWorkflowOperation<
  Args extends readonly unknown[],
  Output,
>(name: string, implementation: (...args: Args) => Promise<Output>) {
  const definition: WorkflowOperationDefinition = { name };
  return Object.assign(
    (...args: Args) =>
      withTrace(
        `workflow.${name}`,
        () =>
          withTrace(`workflow.${name}.result`, () => implementation(...args), {
            "cubby.workflow": name,
            "cubby.workflow.step": "result",
            "cubby.workflow.step_type": "call",
          }),
        { "cubby.workflow": name },
      ),
    { definition },
  );
}

/** Bind transport-independent arguments without hiding the executable graph.
 * The argument adapter only supplies context/input/options; application
 * decisions belong to the definition's registered steps. */
export function bindWorkflow<Context, Input, Output>(
  definition: WorkflowDefinition<Context, Input, Output>,
): ((context: Context, input: Input) => Promise<Output>) & {
  readonly definition: WorkflowDefinition<Context, Input, Output>;
};
export function bindWorkflow<
  Context,
  Input,
  Output,
  Args extends readonly unknown[],
>(
  definition: WorkflowDefinition<Context, Input, Output>,
  prepare: (...args: Args) => WorkflowExecutionOptions<Context, Input>,
): ((...args: Args) => Promise<Output>) & {
  readonly definition: WorkflowDefinition<Context, Input, Output>;
};
export function bindWorkflow<
  Context,
  Input,
  Output,
  Args extends readonly unknown[] = readonly [Context, Input],
>(
  definition: WorkflowDefinition<Context, Input, Output>,
  prepare?: (...args: Args) => WorkflowExecutionOptions<Context, Input>,
) {
  if (prepare)
    return Object.assign(
      (...args: Args) => executeWorkflow(definition, prepare(...args)),
      { definition },
    );
  return Object.assign(
    (context: Context, input: Input) =>
      executeWorkflow(definition, { context, input }),
    { definition },
  );
}
