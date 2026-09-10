import {
  callStep,
  branchStep,
  attemptStep,
  committedCallStep,
  committedEffectStep,
  defineWorkflow,
  defineWorkflowFunction,
  mapWorkflowValue,
  mapStep,
  parallelStep,
  workflowInput,
  workflowValue,
  type WorkflowDefinition,
  type WorkflowFunctionContext,
  type WorkflowStep,
} from "./definition";

type Values<Input, Outputs> = Readonly<{ input: Input } & Outputs>;
type StepName<Name extends string, Outputs> = Name &
  (Name extends keyof Outputs | "input" ? never : unknown) &
  (string extends Name ? never : unknown);
type StepFunction<Context, Input, Output = unknown> = (
  execution: WorkflowFunctionContext<Context>,
  input: Input,
) => Promise<Output>;
type ParallelOutputs<Runs> = {
  [Key in keyof Runs]: Runs[Key] extends (...args: never[]) => infer Result
    ? Awaited<Result>
    : never;
};

/** A sequential declaration lowers to the same graph as the explicit node
 * constructors. Every function gets a stable workflow/step name; downstream
 * selectors can only see outputs produced earlier in the declaration. */
class WorkflowBuilder<Context, Input, Outputs extends object> {
  constructor(
    private readonly name: string,
    private readonly steps: readonly WorkflowStep<Context, Input>[],
    private readonly keys: readonly string[],
  ) {}

  private values() {
    return workflowValue<Input, Values<Input, Outputs>>(
      ["$input", ...this.keys],
      (state) => {
        // SAFETY: keys are appended only with the matching typed step output.
        // Reserved input and duplicate keys are rejected before construction.
        return {
          input: state.input,
          ...Object.fromEntries(
            this.keys.map((key) => [key, state.outputs.get(key)]),
          ),
        } as Values<Input, Outputs>;
      },
    );
  }

  call<Name extends string, Output>(
    name: StepName<Name, Outputs>,
    run: (
      execution: WorkflowFunctionContext<Context>,
      values: Values<Input, Outputs>,
    ) => Promise<Output>,
  ) {
    return this.append<Name, Output>(name, run, "call");
  }

  commit<Name extends string, Output>(
    name: StepName<Name, Outputs>,
    run: (
      execution: WorkflowFunctionContext<Context>,
      values: Values<Input, Outputs>,
    ) => Promise<Output>,
  ) {
    return this.append<Name, Output>(name, run, "committedCall");
  }

  effect<Name extends string, Output>(
    name: StepName<Name, Outputs>,
    run: (
      execution: WorkflowFunctionContext<Context>,
      values: Values<Input, Outputs>,
    ) => Promise<Output>,
  ) {
    return this.append<Name, Output>(name, run, "committedEffect");
  }

  parallel<
    Name extends string,
    Runs extends Record<string, StepFunction<Context, Values<Input, Outputs>>>,
  >(name: StepName<Name, Outputs>, concurrency: number, runs: Runs) {
    const branches = Object.fromEntries(
      Object.entries(runs).map(([key, run]) => {
        const step = callStep({
          name: key,
          fn: defineWorkflowFunction(`${this.name}.${name}.${key}`, run),
          input: workflowInput<Values<Input, Outputs>>(),
        });
        return [
          key,
          defineWorkflow({ name: key, steps: [step], output: step.output }),
        ];
      }),
    );
    // SAFETY: Each input function becomes exactly one branch under its original
    // key. That branch returns the same function's output without conversion.
    const typedBranches = branches as {
      [Key in keyof Runs]: WorkflowDefinition<
        Context,
        Values<Input, Outputs>,
        ParallelOutputs<Runs>[Key]
      >;
    };
    const step = parallelStep<
      Context,
      Input,
      Values<Input, Outputs>,
      ParallelOutputs<Runs>
    >({
      name,
      concurrency,
      input: this.values(),
      branches: typedBranches,
    });
    return this.add<Name, ParallelOutputs<Runs>>(name, step);
  }

  map<Name extends string, Item, Output>(
    name: StepName<Name, Outputs>,
    options: {
      items: (values: Values<Input, Outputs>) => readonly Item[];
      concurrency: number;
      run: StepFunction<
        Context,
        { item: Item; index: number; values: Values<Input, Outputs> },
        Output
      >;
    },
  ) {
    type ItemInput = {
      item: Item;
      index: number;
      values: Values<Input, Outputs>;
    };
    const item = callStep({
      name: "item",
      fn: defineWorkflowFunction(`${this.name}.${name}.item`, options.run),
      input: workflowInput<ItemInput>(),
    });
    const step = mapStep({
      name,
      items: mapWorkflowValue(this.values(), (values) =>
        options.items(values).map((item, index) => ({ item, index, values })),
      ),
      concurrency: options.concurrency,
      workflow: defineWorkflow({
        name: `${this.name}.${name}.item`,
        steps: [item],
        output: item.output,
      }),
    });
    return this.add<Name, Output[]>(name, step);
  }

  mapWorkflow<Name extends string, Item, Output>(
    name: StepName<Name, Outputs>,
    options: {
      items: (values: Values<Input, Outputs>) => readonly Item[];
      concurrency: number;
      workflow: WorkflowDefinition<Context, Item, Output>;
    },
  ) {
    const step = mapStep({
      name,
      items: mapWorkflowValue(this.values(), options.items),
      concurrency: options.concurrency,
      workflow: options.workflow,
    });
    return this.add<Name, Output[]>(name, step);
  }

  branch<Name extends string, TrueOutput, FalseOutput>(
    name: StepName<Name, Outputs>,
    options: {
      when: StepFunction<Context, Values<Input, Outputs>, boolean>;
      whenTrue: (
        branch: WorkflowBuilder<
          Context,
          Values<Input, Outputs>,
          Record<never, never>
        >,
      ) => WorkflowDefinition<Context, Values<Input, Outputs>, TrueOutput>;
      whenFalse: (
        branch: WorkflowBuilder<
          Context,
          Values<Input, Outputs>,
          Record<never, never>
        >,
      ) => WorkflowDefinition<Context, Values<Input, Outputs>, FalseOutput>;
    },
  ) {
    const step = branchStep({
      name,
      input: this.values(),
      when: defineWorkflowFunction(`${this.name}.${name}.when`, options.when),
      whenTrue: options.whenTrue(
        new WorkflowBuilder(`${this.name}.${name}.then`, [], []),
      ),
      whenFalse: options.whenFalse(
        new WorkflowBuilder(`${this.name}.${name}.otherwise`, [], []),
      ),
    });
    return this.add<Name, TrueOutput | FalseOutput>(name, step);
  }

  attempt<Name extends string, Output>(
    name: StepName<Name, Outputs>,
    options: {
      attempt: (
        branch: WorkflowBuilder<
          Context,
          Values<Input, Outputs>,
          Record<never, never>
        >,
      ) => WorkflowDefinition<Context, Values<Input, Outputs>, Output>;
      recover: (
        branch: WorkflowBuilder<
          Context,
          { readonly input: Values<Input, Outputs>; readonly error: unknown },
          Record<never, never>
        >,
      ) => WorkflowDefinition<
        Context,
        { readonly input: Values<Input, Outputs>; readonly error: unknown },
        Output
      >;
    },
  ) {
    const step = attemptStep({
      name,
      input: this.values(),
      attempt: options.attempt(
        new WorkflowBuilder(`${this.name}.${name}.attempt`, [], []),
      ),
      recover: options.recover(
        new WorkflowBuilder(`${this.name}.${name}.recover`, [], []),
      ),
    });
    return this.add<Name, Output>(name, step);
  }

  private append<Name extends string, Output>(
    name: Name,
    run: (
      execution: WorkflowFunctionContext<Context>,
      values: Values<Input, Outputs>,
    ) => Promise<Output>,
    kind: "call" | "committedCall" | "committedEffect",
  ) {
    const fn = defineWorkflowFunction(`${this.name}.${name}`, run);
    const construct = {
      call: callStep,
      committedCall: committedCallStep,
      committedEffect: committedEffectStep,
    }[kind];
    const step = construct({
      name,
      fn,
      input: this.values(),
    });
    return this.add<Name, Output>(name, step);
  }

  private add<Name extends string, Output>(
    name: Name,
    step: WorkflowStep<Context, Input>,
  ) {
    if (!name || name === "input" || this.keys.includes(name)) {
      throw new Error(
        `Workflow ${this.name} has duplicate or reserved step ${name}`,
      );
    }
    return new WorkflowBuilder<Context, Input, Outputs & Record<Name, Output>>(
      this.name,
      [...this.steps, step],
      [...this.keys, name],
    );
  }

  output<Output>(select: (values: Values<Input, Outputs>) => Output) {
    return defineWorkflow({
      name: this.name,
      steps: this.steps,
      output: mapWorkflowValue(this.values(), select),
    });
  }
}

export const workflow = <Context, Input>(name: string) =>
  new WorkflowBuilder<Context, Input, Record<never, never>>(name, [], []);
