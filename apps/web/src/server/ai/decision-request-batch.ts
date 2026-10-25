import { sha256Hex } from "@cubby/shared/sha256";

import type { DecisionPort } from "./decision-model";

/** Common conservative text bound for single and multi-question requests. */
export const DECISION_CONTEXT_BYTE_LIMIT = 32_000;

type ChoiceInput = Parameters<DecisionPort>[0];
type ChoiceResponse = Awaited<ReturnType<DecisionPort>>;
type ChoiceUsage = NonNullable<ChoiceResponse["usage"]>;
/**
 * `usage` stays on the first entry so the shared call is counted once;
 * `questionUsage` is every entry's even share of it, which is what a later
 * cache hit for that one question avoids.
 */
export type BatchedChoiceResponse = ChoiceResponse & {
  questionUsage?: ChoiceUsage;
};
export type DecisionQuestionsInput = Omit<ChoiceInput, "questions"> & {
  questions: Record<string, ChoiceInput["questions"]["selection"]>;
};
export type DecisionQuestionsResponse = Omit<ChoiceResponse, "answers"> & {
  answers: Record<string, ChoiceResponse["answers"]["selection"]>;
};
export function decisionInputFitsContext(
  input: DecisionQuestionsInput,
): boolean {
  const { images: _images, ...text } = input;
  return (
    new TextEncoder().encode(JSON.stringify(text)).byteLength <=
    DECISION_CONTEXT_BYTE_LIMIT
  );
}

type Entry = {
  index: number;
  group: string;
  input: ChoiceInput;
  execute(input: DecisionQuestionsInput): Promise<DecisionQuestionsResponse>;
  resolve(value: BatchedChoiceResponse): void;
  reject(error: unknown): void;
};

function combine(entries: Entry[]): DecisionQuestionsInput {
  if (entries.length === 1) return entries[0]!.input;
  return {
    ...(entries[0]!.input.images?.length
      ? { images: entries[0]!.input.images }
      : {}),
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

  constructor(
    private readonly count: number,
    private readonly concurrency = 4,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error("Decision request concurrency must be positive");
  }

  ready(index: number) {
    this.observed.add(index);
    if (this.observed.size === this.count) this.flush();
  }

  async request(
    index: number,
    group: string,
    input: ChoiceInput,
    execute: Entry["execute"],
  ): Promise<BatchedChoiceResponse> {
    const media = input.images?.length
      ? await sha256Hex(JSON.stringify(input.images))
      : null;
    const key = JSON.stringify([group, media]);
    return new Promise((resolve, reject) => {
      this.entries.push({ index, group: key, input, execute, resolve, reject });
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
    const chunks: Entry[][] = [];
    for (const group of groups.values()) {
      let chunk: Entry[] = [];
      for (const entry of group) {
        const next = [...chunk, entry];
        if (
          chunk.length &&
          (next.length > 64 || !decisionInputFitsContext(combine(next)))
        ) {
          chunks.push(chunk);
          chunk = [];
        }
        chunk.push(entry);
      }
      if (chunk.length) chunks.push(chunk);
    }
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) await this.dispatch(chunks[next++]!);
    };
    for (
      let index = 0;
      index < Math.min(this.concurrency, chunks.length);
      index++
    )
      void worker();
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
      const share = (tokens: number | undefined) =>
        tokens === undefined ? undefined : Math.round(tokens / entries.length);
      const questionUsage = response.usage && {
        input_tokens: share(response.usage.input_tokens),
        output_tokens: share(response.usage.output_tokens),
      };
      entries.forEach((entry, index) =>
        entry.resolve({
          answers: { selection: answers[index]! },
          ...(index === 0 && response.usage ? { usage: response.usage } : {}),
          ...(questionUsage ? { questionUsage } : {}),
        }),
      );
    } catch (error) {
      entries.forEach((entry) => entry.reject(error));
    }
  }
}
