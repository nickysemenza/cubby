import {
  callStep,
  defineWorkflow,
  defineWorkflowFunction,
  workflowInput,
  type WorkflowDefinition,
} from "./definition";
import { executeWorkflow, type WorkflowExecutionOptions } from "./execute";

/** A one-function operation needs no handwritten orchestration wrapper. Its
 * definition remains available to the same inspector as multi-step workflows.
 * Args are server-only execution arguments, never a transport schema. */
export function defineWorkflowOperation<
  Args extends readonly unknown[],
  Output,
>(name: string, implementation: (...args: Args) => Promise<Output>) {
  const fn = defineWorkflowFunction<undefined, Args, Output>(
    name,
    async (_, args) => await implementation(...args),
  );
  const step = callStep({ name: "result", fn, input: workflowInput<Args>() });
  const definition = defineWorkflow({
    name,
    steps: [step],
    output: step.output,
  });
  return bindWorkflow(definition, (...args: Args) => ({
    context: undefined,
    input: args,
  }));
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
