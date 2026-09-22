import { importRunId } from "@cubby/schemas/identifiers";
import { describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";

import { FIELD_SUGGESTION_FEATURE } from "./features";
import { JEV_MAX_CANDIDATES, type JevPort } from "./jev";
import {
  type AiSelectionSpec,
  type AiSelectionUsage,
  runAiSelection,
} from "./selection";

const db = new Database(() => {
  throw new Error("Selection unit ports do not resolve a database runtime");
});

const usage: AiSelectionUsage = {
  db,
  runId: importRunId.parse("00000000-0000-4000-8000-000000000001"),
  operation: "test-select",
  cacheStatus: "none",
};

interface Widget {
  id: string;
  label: string;
}

// Any decision feature record will do here: `runAiSelection` only forwards
// it to `runJevChoice`, whose own contract is covered in `jev.unit.test.ts`.
const spec: AiSelectionSpec<Widget> = {
  feature: FIELD_SUGGESTION_FEATURE,
  rules: "Pick the widget that best matches the subject.",
  idOf: (widget) => widget.id,
  renderLine: (widget) => `${widget.id}: ${widget.label}`,
  maxCandidates: 2,
};

const widgets: Widget[] = [
  { id: "a", label: "red" },
  { id: "b", label: "blue" },
  { id: "c", label: "green" },
];

function jevFor(choice: string, probabilities: Record<string, number>) {
  const port: JevPort = vi.fn(async () => ({
    answers: {
      selection: {
        type: "choice" as const,
        choice,
        confidence: 0.9,
        probabilities,
      },
    },
  }));
  return port;
}

describe("runAiSelection", () => {
  it("asks Jev over the rendered shortlist plus a none choice, and resolves the index", async () => {
    const jev = jevFor("c0", { c0: 0.9, c1: 0.05, none: 0.05 });

    const outcome = await runAiSelection(spec, {
      subject: "find the red one",
      candidates: widgets.slice(0, 2),
      usage,
      jev,
    });

    expect(jev).toHaveBeenCalledWith({
      state: "find the red one",
      questions: {
        selection: {
          type: "choice",
          instructions: expect.stringContaining(spec.rules),
          criteria: {
            c0: "a: red",
            c1: "b: blue",
            none: expect.any(String),
          },
        },
      },
    });
    expect(outcome).toEqual({
      selected: { id: "a", label: "red" },
      confidence: "high",
      probability: 0.9,
      reasoning: "",
      alternatives: [
        { candidate: { id: "b", label: "blue" }, probability: 0.05 },
      ],
      evaluated: true,
    });
  });

  it("resolves a none answer to null while keeping Jev's confidence", async () => {
    const outcome = await runAiSelection(spec, {
      subject: "x",
      candidates: widgets.slice(0, 2),
      usage,
      jev: jevFor("none", { c0: 0.2, c1: 0.1, none: 0.7 }),
    });

    expect(outcome).toMatchObject({ selected: null, confidence: "medium" });
  });

  it("returns null without calling the model when there are no candidates", async () => {
    const jev: JevPort = vi.fn();

    const outcome = await runAiSelection(spec, {
      subject: "x",
      candidates: [],
      usage,
      jev,
    });

    expect(jev).not.toHaveBeenCalled();
    expect(outcome.selected).toBeNull();
    expect(outcome.confidence).toBe("low");
    expect(outcome.alternatives).toEqual([]);
    expect(outcome.evaluated).toBe(false);
  });

  it("truncates candidates to maxCandidates before choosing", async () => {
    const jev = jevFor("c1", { c0: 0.1, c1: 0.8, none: 0.1 });

    const outcome = await runAiSelection(spec, {
      subject: "x",
      candidates: widgets,
      usage,
      jev,
    });

    // "c" was truncated away before Jev ever saw it.
    expect(jev).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: {
          selection: expect.objectContaining({
            criteria: { c0: "a: red", c1: "b: blue", none: expect.any(String) },
          }),
        },
      }),
    );
    expect(outcome.selected).toEqual({ id: "b", label: "blue" });
  });
});

// A consumer declares its prompt-size bound in its own terms (location
// suggestion allows 400) and never learns the decision tier's; a roster
// larger than Jev takes in one choice overflows to the fast chat tier and
// its id-echo answer, rather than throwing or being silently truncated.
describe("runAiSelection overflow", () => {
  const roster = Array.from({ length: JEV_MAX_CANDIDATES + 1 }, (_, i) => ({
    id: `w${i}`,
    label: `widget ${i}`,
  }));
  const bigSpec = { ...spec, maxCandidates: 400 };

  it("sends the shared frame, the rules, and the full rendered shortlist to the overflow model", async () => {
    const jev: JevPort = vi.fn();
    const select = vi.fn(async () => ({
      selectedId: "  W7 ",
      confidence: "medium" as const,
      reasoning: "closer match",
    }));

    const outcome = await runAiSelection(bigSpec, {
      subject: "find the seventh",
      candidates: roster,
      usage,
      jev,
      ai: { select },
    });

    expect(jev).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith({
      rules: spec.rules,
      subject: "find the seventh",
      shortlist: roster.map((w) => `${w.id}: ${w.label}`).join("\n"),
      usage,
    });
    // Case/whitespace-insensitive: the model is copying an id out of prose.
    expect(outcome).toEqual({
      selected: { id: "w7", label: "widget 7" },
      confidence: "medium",
      probability: null,
      reasoning: "closer match",
      alternatives: [],
      evaluated: true,
    });
  });

  it("resolves an invented id to null while keeping the model's reasoning", async () => {
    const outcome = await runAiSelection(bigSpec, {
      subject: "x",
      candidates: roster,
      usage,
      ai: {
        select: async () => ({
          selectedId: "ghost",
          confidence: "low",
          reasoning: "hallucinated an id",
        }),
      },
    });

    expect(outcome).toEqual({
      selected: null,
      confidence: "low",
      probability: null,
      reasoning: "hallucinated an id",
      alternatives: [],
      evaluated: true,
    });
  });
});
