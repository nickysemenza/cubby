import type { DecisionPort } from "./decision-model";

/** Common conservative text bound for single and multi-question requests. */
export const DECISION_CONTEXT_BYTE_LIMIT = 32_000;

type ChoiceInput = Parameters<DecisionPort>[0];
type ChoiceResponse = Awaited<ReturnType<DecisionPort>>;
export type DecisionQuestionsInput = Omit<ChoiceInput, "questions"> & {
  questions: Record<string, ChoiceInput["questions"]["selection"]>;
};
export type DecisionQuestionsResponse = Omit<ChoiceResponse, "answers"> & {
  answers: Record<string, ChoiceResponse["answers"]["selection"]>;
};
type Entry = {
  index: number;
  group: string;
  input: ChoiceInput;
  execute(input: DecisionQuestionsInput): Promise<DecisionQuestionsResponse>;
  resolve(value: ChoiceResponse): void;
  reject(error: unknown): void;
};

function combine(entries: Entry[]): DecisionQuestionsInput {
  if (entries.length === 1) return entries[0]!.input;
  return {
    state:
      "Independent decisions. Each question contains its own evidence. Do not use evidence from other questions.",
    questions: Object.fromEntries(
      entries.map((entry) => [
        `q${entry.index}`,
        {
          ...entry.input.questions.selection,
          instructions: `${entry.input.questions.selection.instructions}\nEvidence for this question only:\n${entry.input.state}`,
        },
      ]),
    ),
  };
}

/** A finite caller-owned set, not a timer window or a cross-request queue. */
export class DecisionRequestBatch {
  private observed = new Set<number>();
  private entries: Entry[] = [];

  constructor(private readonly count: number) {}

  ready(index: number) {
    this.observed.add(index);
    if (this.observed.size === this.count) this.flush();
  }

  request(
    index: number,
    group: string,
    input: ChoiceInput,
    execute: Entry["execute"],
  ): Promise<ChoiceResponse> {
    return new Promise((resolve, reject) => {
      this.entries.push({ index, group, input, execute, resolve, reject });
      this.ready(index);
    });
  }

  private flush() {
    const groups = new Map<string, Entry[]>();
    for (const entry of this.entries.splice(0)) {
      const group = groups.get(entry.group) ?? [];
      group.push(entry);
      groups.set(entry.group, group);
    }
    for (const group of groups.values()) {
      let chunk: Entry[] = [];
      for (const entry of group) {
        const next = [...chunk, entry];
        if (
          chunk.length &&
          (next.length > 64 ||
            new TextEncoder().encode(JSON.stringify(combine(next))).byteLength >
              DECISION_CONTEXT_BYTE_LIMIT)
        ) {
          void this.dispatch(chunk);
          chunk = [];
        }
        chunk.push(entry);
      }
      if (chunk.length) void this.dispatch(chunk);
    }
  }

  private async dispatch(entries: Entry[]) {
    try {
      const response = await entries[0]!.execute(combine(entries));
      const answers = entries.map(
        (entry) =>
          response.answers[
            entries.length === 1 ? "selection" : `q${entry.index}`
          ],
      );
      if (
        Object.keys(response.answers).length !== entries.length ||
        answers.some((answer) => !answer)
      )
        throw new Error(
          "The decision model returned an unexpected question set.",
        );
      entries.forEach((entry, index) =>
        entry.resolve({
          answers: { selection: answers[index]! },
          ...(index === 0 && response.usage ? { usage: response.usage } : {}),
        }),
      );
    } catch (error) {
      entries.forEach((entry) => entry.reject(error));
    }
  }
}
