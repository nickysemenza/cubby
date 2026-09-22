import type { UnparsedError } from "~/lib/error-utils";
import { withTrace } from "~/server/tracing";

import type {
  WorkflowDefinition,
  WorkflowFunctionScope,
  WorkflowState,
  WorkflowStep,
} from "./definition";

// Workers bind AbortController to the active request; never cache one at module scope.
const uncancelledSignal = () => new AbortController().signal;

type WorkflowEvent = {
  readonly workflow: string;
  readonly step: string;
  readonly type: WorkflowStep<unknown, unknown>["type"] | "workflow";
  readonly state: "queued" | "started" | "succeeded" | "failed" | "cancelled";
  readonly committed: boolean;
  readonly error?: unknown;
};

type WorkflowObserver = (event: WorkflowEvent) => void;

export class WorkflowCancelledError extends Error {
  readonly committed: boolean;
  readonly effectsPending: boolean;

  constructor(options: { committed: boolean; effectsPending: boolean }) {
    super(
      options.committed
        ? "Workflow cancelled after its transaction committed"
        : "Workflow cancelled before commit",
    );
    this.name = "WorkflowCancelledError";
    this.committed = options.committed;
    this.effectsPending = options.effectsPending;
  }
}

export class WorkflowEffectError extends Error {
  readonly committed = true;
  constructor(
    readonly effect: string,
    readonly pendingEffects: readonly string[],
    cause: unknown,
    /** The failure the run was unwinding when this effect failed. */
    readonly stoppedBy?: UnparsedError,
  ) {
    super(`Workflow committed, but effect ${effect} failed`, { cause });
    this.name = "WorkflowEffectError";
  }
}

type Execution<Context, Input> = {
  readonly workflow: string;
  context: Context;
  readonly input: Input;
  readonly signal: AbortSignal;
  observer?: WorkflowObserver;
  readonly outputs: Map<string, unknown>;
  scope: WorkflowFunctionScope;
  committed: boolean;
  /** A write boundary has started. Its failure is ambiguous, so recovery must
   * not replay the attempt even when no confirmed commit result returned. */
  writeAttemptCount: number;
};

const notify = <Context, Input>(
  execution: Execution<Context, Input>,
  event: Omit<WorkflowEvent, "workflow" | "committed">,
) => {
  try {
    execution.observer?.({
      workflow: execution.workflow,
      committed: execution.committed,
      ...event,
    });
  } catch (error) {
    // SILENT: diagnostic subscribers cannot roll back a write or prevent
    // required effects after a successful commit.
    console.error("Workflow observer failed", error);
  }
};

const cancellation = (committed: boolean, effectsPending: boolean) =>
  new WorkflowCancelledError({ committed, effectsPending });

const checkCancelled = <Context, Input>(
  execution: Execution<Context, Input>,
) => {
  if (execution.signal.aborted) {
    throw cancellation(execution.committed, false);
  }
};

const stateOf = <Context, Input>(
  execution: Execution<Context, Input>,
): WorkflowState<Input> => ({
  input: execution.input,
  outputs: execution.outputs,
});

const runBounded = async <Item, Output>(
  items: readonly Item[],
  concurrency: number,
  run: (item: Item, index: number) => Promise<Output>,
): Promise<Output[]> => {
  const outputs: Output[] = [];
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        outputs[index] = await run(items[index]!, index);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  // Settle already-started work before reporting failure. A rejected branch
  // must not leave sibling writes running after its caller receives an error.
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  if (failed) throw failure;
  return outputs;
};

const runDefinition = async <Context, Input, Output>(
  definition: WorkflowDefinition<Context, Input, Output>,
  execution: Execution<Context, Input>,
): Promise<Output> => {
  try {
    await runSteps(definition.steps, execution);
    return definition.output.resolve(stateOf(execution));
  } catch (error) {
    // Runtime durability/cancellation evidence must survive domain error
    // translation. The failure function translates application failures only.
    if (
      !definition.failure ||
      error instanceof WorkflowCancelledError ||
      error instanceof WorkflowEffectError
    )
      throw error;
    return definition.failure.run(
      {
        context: execution.context,
        signal: execution.signal,
        scope: execution.scope,
      },
      { input: execution.input, error },
    );
  }
};

const assertCommittedEffectScope = <Context, Input>(
  execution: Execution<Context, Input>,
) => {
  if (execution.scope !== "workflow" || !execution.committed)
    throw new Error("Committed effects require a completed domain commit");
};

const notifySucceededStep = <Context, Input>(
  step: WorkflowStep<Context, Input>,
  execution: Execution<Context, Input>,
) => {
  notify(execution, { step: step.name, type: step.type, state: "succeeded" });
};

const runStep = async <Context, Input>(
  step: WorkflowStep<Context, Input>,
  execution: Execution<Context, Input>,
): Promise<void> => {
  if (step.type !== "committedEffect") checkCancelled(execution);
  notify(execution, {
    step: step.name,
    type: step.type,
    state: "started",
  });
  try {
    await withTrace(
      `workflow.${execution.workflow}.${step.name}`,
      async (span) => {
        span.setAttributes({
          "cubby.workflow": execution.workflow,
          "cubby.workflow.step": step.name,
          "cubby.workflow.step_type": step.type,
        });
        switch (step.type) {
          case "call":
          case "committedCall": {
            if (step.type === "committedCall") execution.writeAttemptCount++;
            const result = await step.fn.run(
              {
                context: execution.context,
                signal: execution.signal,
                scope: execution.scope,
              },
              step.input.resolve(stateOf(execution)),
            );
            if (step.type === "committedCall") {
              execution.committed = true;
            }
            execution.outputs.set(step.name, result);
            break;
          }
          case "committedEffect": {
            assertCommittedEffectScope(execution);
            const result = await step.fn.run(
              {
                context: execution.context,
                signal: uncancelledSignal(),
                scope: "afterCommit",
              },
              step.input.resolve(stateOf(execution)),
            );
            execution.outputs.set(step.name, result);
            break;
          }
          case "branch": {
            const input = step.input.resolve(stateOf(execution));
            const selected = await step.when.run(
              {
                context: execution.context,
                signal: execution.signal,
                scope: execution.scope,
              },
              input,
            );
            const result = await runChild(
              selected ? step.whenTrue : step.whenFalse,
              execution,
              input,
            );
            execution.outputs.set(step.name, result);
            break;
          }
          case "map": {
            const items = step.items.resolve(stateOf(execution));
            const results = await runBounded(
              items,
              step.concurrency,
              async (item) => {
                checkCancelled(execution);
                return runChild(step.workflow, execution, item);
              },
            );
            execution.outputs.set(step.name, results);
            break;
          }
          case "parallel": {
            const entries = Object.entries(step.branches);
            const input = step.input.resolve(stateOf(execution));
            const results = await runBounded(
              entries,
              step.concurrency,
              async ([name, branch]) =>
                [name, await runChild(branch, execution, input)] as const,
            );
            execution.outputs.set(step.name, Object.fromEntries(results));
            break;
          }
          case "attempt": {
            await runAttempt(step, execution);
            break;
          }
        }
      },
    );
    if (step.type !== "committedCall" && step.type !== "committedEffect")
      checkCancelled(execution);
    notifySucceededStep(step, execution);
  } catch (error) {
    notify(execution, {
      step: step.name,
      type: step.type,
      state: error instanceof WorkflowCancelledError ? "cancelled" : "failed",
      error,
    });
    throw error;
  }
};

const runSteps = async <Context, Input>(
  steps: readonly WorkflowStep<Context, Input>[],
  execution: Execution<Context, Input>,
) => {
  for (const [index, step] of steps.entries()) {
    try {
      await runStep(step, execution);
    } catch (error) {
      if (step.type !== "committedEffect") throw error;
      const pending: string[] = [];
      for (const remaining of steps.slice(index)) {
        if (remaining.type !== "committedEffect") break;
        pending.push(remaining.name);
      }
      throw new WorkflowEffectError(step.name, pending, error);
    }
  }
  checkCancelled(execution);
};

const runChild = async <Context, Input, Output, ParentInput>(
  definition: WorkflowDefinition<Context, Input, Output>,
  parent: Execution<Context, ParentInput>,
  input: Input,
) => {
  const child: Execution<Context, Input> = {
    workflow: `${parent.workflow}.${definition.name}`,
    context: parent.context,
    input,
    signal: parent.signal,
    outputs: new Map(),
    scope: parent.scope,
    committed: parent.committed,
    writeAttemptCount: parent.writeAttemptCount,
  };
  if (parent.observer) child.observer = parent.observer;
  try {
    return await runDefinition(definition, child);
  } finally {
    parent.committed ||= child.committed;
    parent.writeAttemptCount = Math.max(
      parent.writeAttemptCount,
      child.writeAttemptCount,
    );
  }
};

const runAttempt = async <Context, Input>(
  step: Extract<WorkflowStep<Context, Input>, { type: "attempt" }>,
  execution: Execution<Context, Input>,
) => {
  const input = step.input.resolve(stateOf(execution));
  const writeAttemptsBefore = execution.writeAttemptCount;
  try {
    const result = await runChild(step.attempt, execution, input);
    execution.outputs.set(step.name, result);
  } catch (error) {
    if (
      error instanceof WorkflowCancelledError ||
      error instanceof WorkflowEffectError ||
      execution.writeAttemptCount !== writeAttemptsBefore
    )
      throw error;
    const result = await runChild(step.recover, execution, { input, error });
    execution.outputs.set(step.name, result);
  }
};

export type WorkflowExecutionOptions<Context, Input> = {
  readonly context: Context;
  readonly input: Input;
  readonly signal?: AbortSignal;
  observer?: WorkflowObserver;
};

export const executeWorkflow = async <Context, Input, Output>(
  definition: WorkflowDefinition<Context, Input, Output>,
  options: WorkflowExecutionOptions<Context, Input>,
): Promise<Output> => {
  const execution: Execution<Context, Input> = {
    workflow: definition.name,
    context: options.context,
    input: options.input,
    signal: options.signal ?? uncancelledSignal(),
    outputs: new Map(),
    scope: "workflow",
    committed: false,
    writeAttemptCount: 0,
  };
  if (options.observer) execution.observer = options.observer;
  notify(execution, {
    step: definition.name,
    type: "workflow",
    state: "started",
  });
  try {
    const result = await withTrace(
      `workflow.${definition.name}`,
      () => runDefinition(definition, execution),
      { "cubby.workflow": definition.name },
    );
    notify(execution, {
      step: definition.name,
      type: "workflow",
      state: "succeeded",
    });
    return result;
  } catch (error) {
    notify(execution, {
      step: definition.name,
      type: "workflow",
      state: error instanceof WorkflowCancelledError ? "cancelled" : "failed",
      error,
    });
    throw error;
  }
};
