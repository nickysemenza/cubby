export type WorkflowDependency = "$input" | string;

export type WorkflowState<Input> = {
  readonly input: Input;
  readonly outputs: ReadonlyMap<string, unknown>;
};

export type WorkflowSelector<Input, Value> = {
  readonly dependencies: readonly WorkflowDependency[];
  readonly resolve: (state: WorkflowState<Input>) => Value;
};

export const workflowInput = <Input>(): WorkflowSelector<Input, Input> => ({
  dependencies: ["$input"],
  resolve: (state) => state.input,
});

export const workflowValue = <Input, Value>(
  dependencies: readonly WorkflowDependency[],
  resolve: (state: WorkflowState<Input>) => Value,
): WorkflowSelector<Input, Value> => ({ dependencies, resolve });

const outputOf = <Input, Output>(
  name: string,
): WorkflowSelector<Input, Output> =>
  workflowValue([name], (state) => {
    if (!state.outputs.has(name))
      throw new Error(`Workflow step ${name} has no output`);
    // SAFETY: The node constructor binds this selector to its registered function's
    // return type. Callers cannot choose a different output type by name.
    return state.outputs.get(name) as Output;
  });

export const mapWorkflowValue = <Input, Value, Output>(
  value: WorkflowSelector<Input, Value>,
  map: (value: Value) => Output,
): WorkflowSelector<Input, Output> =>
  workflowValue(value.dependencies, (state) => map(value.resolve(state)));

export type WorkflowFunctionScope = "workflow" | "afterCommit";

export type WorkflowFunctionContext<Context> = {
  readonly context: Context;
  readonly signal: AbortSignal;
  readonly scope: WorkflowFunctionScope;
};

export type WorkflowFunction<Context, Input, Output> = {
  readonly name: string;
  readonly run: (
    execution: WorkflowFunctionContext<Context>,
    input: Input,
  ) => Promise<Output>;
};

export const defineWorkflowFunction = <Context, Input, Output>(
  name: string,
  run: WorkflowFunction<Context, Input, Output>["run"],
): WorkflowFunction<Context, Input, Output> => ({ name, run });

type CallStep<Context, Input, Value, Output> = {
  readonly type: "call" | "committedCall" | "committedEffect";
  readonly name: string;
  readonly fn: WorkflowFunction<Context, Value, Output>;
  readonly input: WorkflowSelector<Input, Value>;
};

type BranchStep<Context, Input, Value, TrueOutput, FalseOutput> = {
  readonly type: "branch";
  readonly name: string;
  readonly input: WorkflowSelector<Input, Value>;
  readonly when: WorkflowFunction<Context, Value, boolean>;
  readonly whenTrue: WorkflowDefinition<Context, Value, TrueOutput>;
  readonly whenFalse: WorkflowDefinition<Context, Value, FalseOutput>;
};

type MapStep<Context, Input, Item> = {
  readonly type: "map";
  readonly name: string;
  readonly items: WorkflowSelector<Input, readonly Item[]>;
  readonly concurrency: number;
  readonly workflow: WorkflowDefinition<Context, Item, unknown>;
};

type ParallelStep<Context, Input> = {
  readonly type: "parallel";
  readonly name: string;
  readonly concurrency: number;
  readonly input: WorkflowSelector<Input, unknown>;
  readonly branches: Readonly<
    Record<string, WorkflowDefinition<Context, unknown, unknown>>
  >;
};

type AttemptStep<Context, Input, Value, Output> = {
  readonly type: "attempt";
  readonly name: string;
  readonly input: WorkflowSelector<Input, Value>;
  readonly attempt: WorkflowDefinition<Context, Value, Output>;
  readonly recover: WorkflowDefinition<
    Context,
    { readonly input: Value; readonly error: unknown },
    Output
  >;
};

export type WorkflowStep<Context, Input> =
  | CallStep<Context, Input, unknown, unknown>
  | BranchStep<Context, Input, unknown, unknown, unknown>
  | MapStep<Context, Input, unknown>
  | ParallelStep<Context, Input>
  | AttemptStep<Context, Input, unknown, unknown>;

export type WorkflowDefinition<Context, Input, Output> = {
  readonly name: string;
  readonly steps: readonly WorkflowStep<Context, Input>[];
  readonly output: WorkflowSelector<Input, Output>;
  readonly failure?: WorkflowFunction<
    Context,
    { readonly input: Input; readonly error: unknown },
    never
  >;
};

/** The inspectable identity of a direct operation. Unlike a workflow, it has
 * no graph because its implementation runs as one operation-level unit. */
export type WorkflowOperationDefinition = {
  readonly name: string;
};

export const callStep = <Context, Input, Value, Output>(options: {
  name: string;
  fn: WorkflowFunction<Context, Value, Output>;
  input: WorkflowSelector<Input, Value>;
}): WorkflowStep<Context, Input> & {
  readonly output: WorkflowSelector<Input, Output>;
} =>
  // SAFETY: The paired selector returns the registered function's input type;
  // heterogeneous storage erases only that intermediate type.
  ({
    type: "call",
    ...options,
    output: outputOf<Input, Output>(options.name),
  }) as WorkflowStep<Context, Input> & {
    readonly output: WorkflowSelector<Input, Output>;
  };

/** For a domain function that owns and awaits its committed database writes. */
export const committedCallStep = <Context, Input, Value, Output>(options: {
  name: string;
  fn: WorkflowFunction<Context, Value, Output>;
  input: WorkflowSelector<Input, Value>;
}): WorkflowStep<Context, Input> & {
  readonly output: WorkflowSelector<Input, Output>;
} =>
  // SAFETY: The selector and function share Value, and the output selector is
  // bound to that function's Output before heterogeneous node storage.
  ({
    type: "committedCall",
    ...options,
    output: outputOf<Input, Output>(options.name),
  }) as WorkflowStep<Context, Input> & {
    readonly output: WorkflowSelector<Input, Output>;
  };

/** Required follow-up to a domain-owned commit. Consecutive effects finish
 * before cancellation is reported and expose their outputs to later effects. */
export const committedEffectStep = <Context, Input, Value, Output>(options: {
  name: string;
  fn: WorkflowFunction<Context, Value, Output>;
  input: WorkflowSelector<Input, Value>;
}): WorkflowStep<Context, Input> & {
  readonly output: WorkflowSelector<Input, Output>;
} =>
  // SAFETY: The registered function and input selector share Value; the paired
  // output selector retains Output when the heterogeneous node erases Value.
  ({
    type: "committedEffect",
    ...options,
    output: outputOf<Input, Output>(options.name),
  }) as WorkflowStep<Context, Input> & {
    readonly output: WorkflowSelector<Input, Output>;
  };

export const branchStep = <
  Context,
  Input,
  Value,
  TrueOutput,
  FalseOutput,
>(options: {
  name: string;
  input: WorkflowSelector<Input, Value>;
  when: WorkflowFunction<Context, Value, boolean>;
  whenTrue: WorkflowDefinition<Context, Value, TrueOutput>;
  whenFalse: WorkflowDefinition<Context, Value, FalseOutput>;
}): WorkflowStep<Context, Input> & {
  readonly output: WorkflowSelector<Input, TrueOutput | FalseOutput>;
} =>
  // SAFETY: Both children and the predicate accept the selector's Value; the
  // output selector preserves the union of the children's actual result types.
  ({
    type: "branch",
    ...options,
    output: outputOf<Input, TrueOutput | FalseOutput>(options.name),
  }) as WorkflowStep<Context, Input> & {
    readonly output: WorkflowSelector<Input, TrueOutput | FalseOutput>;
  };

const boundedConcurrency = (name: string, concurrency: number) => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`${name} concurrency must be a positive integer`);
  }
  return concurrency;
};

export const mapStep = <Context, Input, Item, Output>(options: {
  name: string;
  items: WorkflowSelector<Input, readonly Item[]>;
  concurrency: number;
  workflow: WorkflowDefinition<Context, Item, Output>;
}): WorkflowStep<Context, Input> & {
  readonly output: WorkflowSelector<Input, Output[]>;
} =>
  // SAFETY: Each selected Item is passed to the matching child definition;
  // the executor stores its Output values in input order.
  ({
    type: "map",
    ...options,
    output: outputOf<Input, Output[]>(options.name),
    concurrency: boundedConcurrency(options.name, options.concurrency),
  }) as WorkflowStep<Context, Input> & {
    readonly output: WorkflowSelector<Input, Output[]>;
  };

export const parallelStep = <
  Context,
  Input,
  Value,
  Outputs extends object,
>(options: {
  name: string;
  concurrency: number;
  input: WorkflowSelector<Input, Value>;
  branches: Readonly<
    Record<string, WorkflowDefinition<Context, Value, unknown>>
  > & {
    readonly [Key in keyof Outputs]: WorkflowDefinition<
      Context,
      Value,
      Outputs[Key]
    >;
  };
}): WorkflowStep<Context, Input> & {
  readonly output: WorkflowSelector<Input, Outputs>;
} =>
  // SAFETY: The executor preserves branch keys and each branch's own output;
  // the mapped definition type binds those keys to the output selector.
  ({
    type: "parallel",
    ...options,
    output: outputOf<Input, Outputs>(options.name),
    concurrency: boundedConcurrency(options.name, options.concurrency),
  }) as WorkflowStep<Context, Input> & {
    readonly output: WorkflowSelector<Input, Outputs>;
  };

export const attemptStep = <Context, Input, Value, Output>(options: {
  name: string;
  input: WorkflowSelector<Input, Value>;
  attempt: WorkflowDefinition<Context, Value, Output>;
  recover: WorkflowDefinition<
    Context,
    { readonly input: Value; readonly error: unknown },
    Output
  >;
}): WorkflowStep<Context, Input> & {
  readonly output: WorkflowSelector<Input, Output>;
} =>
  // SAFETY: the selected input and both child definitions share Value and Output.
  ({
    type: "attempt",
    ...options,
    output: outputOf<Input, Output>(options.name),
  }) as WorkflowStep<Context, Input> & {
    readonly output: WorkflowSelector<Input, Output>;
  };

const validateCommittedEffects = <Context, Input>(
  steps: readonly WorkflowStep<Context, Input>[],
) => {
  let followsCommit = false;
  for (const step of steps) {
    if (step.type === "committedEffect" && !followsCommit)
      throw new Error(
        `Committed effect ${step.name} must immediately follow a commit or committed effect`,
      );
    followsCommit =
      step.type === "committedCall" || step.type === "committedEffect";
  }
};

export const defineWorkflow = <Context, Input, Output>(
  definition: WorkflowDefinition<Context, Input, Output>,
): WorkflowDefinition<Context, Input, Output> => {
  const names = new Set<string>();
  const validateSelector = (
    selector: { dependencies: readonly string[] },
    available: ReadonlySet<string>,
  ) => {
    for (const dependency of selector.dependencies) {
      if (!available.has(dependency))
        throw new Error(
          `Workflow ${definition.name} references unavailable output ${dependency}`,
        );
    }
  };
  const validate = (
    steps: readonly WorkflowStep<Context, Input>[],
    initial: ReadonlySet<string>,
  ): Set<string> => {
    const available = new Set(initial);
    validateCommittedEffects(steps);
    for (const step of steps) {
      if (!step.name || names.has(step.name))
        throw new Error(
          `Workflow ${definition.name} has duplicate or empty step ${step.name}`,
        );
      names.add(step.name);
      switch (step.type) {
        case "call":
        case "committedCall":
        case "committedEffect":
          validateSelector(step.input, available);
          available.add(step.name);
          break;
        case "branch":
          validateSelector(step.input, available);

          available.add(step.name);
          break;
        case "map":
          validateSelector(step.items, available);
          available.add(step.name);
          break;
        case "parallel":
          validateSelector(step.input, available);
          available.add(step.name);
          break;
        case "attempt":
          validateSelector(step.input, available);
          available.add(step.name);
          break;
      }
    }
    return available;
  };
  validateSelector(
    definition.output,
    validate(definition.steps, new Set(["$input"])),
  );
  return Object.freeze({
    ...definition,
    steps: Object.freeze([...definition.steps]),
  });
};

type WorkflowStepDescriptor = {
  readonly type: WorkflowStep<unknown, unknown>["type"];
  readonly name: string;
  readonly function?: string;
  readonly dependencies?: readonly WorkflowDependency[];
  readonly concurrency?: number;
  readonly steps?: readonly WorkflowStepDescriptor[];
  readonly alternatives?: {
    readonly whenTrue: readonly WorkflowStepDescriptor[];
    readonly whenFalse: readonly WorkflowStepDescriptor[];
  };
  readonly branches?: Readonly<Record<string, WorkflowDescriptor>>;
};

export type WorkflowDescriptor = {
  readonly name: string;
  readonly failureFunction?: string;
  readonly outputDependencies: readonly WorkflowDependency[];
  readonly steps: readonly WorkflowStepDescriptor[];
};

const describeSteps = <Context, Input>(
  steps: readonly WorkflowStep<Context, Input>[],
): WorkflowStepDescriptor[] =>
  steps.map((step): WorkflowStepDescriptor => {
    switch (step.type) {
      case "call":
      case "committedCall":
      case "committedEffect":
        return {
          type: step.type,
          name: step.name,
          function: step.fn.name,
          dependencies: step.input.dependencies,
        };
      case "branch":
        return {
          type: step.type,
          name: step.name,
          function: step.when.name,
          dependencies: step.input.dependencies,
          branches: {
            whenTrue: inspectWorkflow(step.whenTrue),
            whenFalse: inspectWorkflow(step.whenFalse),
          },
        };
      case "map":
        return {
          type: step.type,
          name: step.name,
          dependencies: step.items.dependencies,
          concurrency: step.concurrency,
          branches: { item: inspectWorkflow(step.workflow) },
        };
      case "parallel":
        return {
          type: step.type,
          name: step.name,
          concurrency: step.concurrency,
          dependencies: step.input.dependencies,
          branches: Object.fromEntries(
            Object.entries(step.branches).map(([name, branch]) => [
              name,
              inspectWorkflow(branch),
            ]),
          ),
        };
      case "attempt":
        return {
          type: step.type,
          name: step.name,
          dependencies: step.input.dependencies,
          branches: {
            attempt: inspectWorkflow(step.attempt),
            recover: inspectWorkflow(step.recover),
          },
        };
    }
  });

export const inspectWorkflow = <Context, Input, Output>(
  definition:
    | WorkflowDefinition<Context, Input, Output>
    | WorkflowOperationDefinition,
): WorkflowDescriptor => {
  if (!("steps" in definition)) {
    return {
      name: definition.name,
      outputDependencies: [],
      steps: [],
    };
  }
  const descriptor: WorkflowDescriptor = {
    name: definition.name,
    outputDependencies: definition.output.dependencies,
    steps: describeSteps(definition.steps),
  };
  if (definition.failure)
    return { ...descriptor, failureFunction: definition.failure.name };
  return descriptor;
};
