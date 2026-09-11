import { describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";

import { LOCATION_SUGGESTION_FEATURE } from "./features";
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
  operation: "test-select",
  cacheStatus: "none",
};

interface Widget {
  id: string;
  label: string;
}

// Any selection feature record will do here: `runAiSelection` only forwards
// it to the port. The prompt assembly it drives is covered in
// `run-feature.unit.test.ts`.
const spec: AiSelectionSpec<Widget> = {
  feature: LOCATION_SUGGESTION_FEATURE,
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

describe("runAiSelection", () => {
  it("sends the shared frame, the spec's rules, and the rendered shortlist", async () => {
    const select = vi.fn(async () => ({
      selectedId: "a",
      confidence: "high" as const,
      reasoning: "matched",
    }));

    await runAiSelection(spec, {
      subject: "find the red one",
      candidates: widgets.slice(0, 2),
      usage,
      ai: { select },
    });

    expect(select).toHaveBeenCalledWith({
      feature: LOCATION_SUGGESTION_FEATURE,
      rules: spec.rules,
      subject: "find the red one",
      shortlist: "a: red\nb: blue",
      usage,
    });
  });

  it("resolves an in-shortlist id back to the matching candidate", async () => {
    const outcome = await runAiSelection(spec, {
      subject: "x",
      candidates: widgets.slice(0, 2),
      usage,
      ai: {
        select: async () => ({
          selectedId: "  B ",
          confidence: "medium",
          reasoning: "closer match",
        }),
      },
    });

    // Case/whitespace-insensitive: the model is copying an id out of prose.
    expect(outcome).toEqual({
      selected: { id: "b", label: "blue" },
      confidence: "medium",
      reasoning: "closer match",
    });
  });

  it("resolves an off-shortlist id to null while keeping the model's reasoning", async () => {
    const outcome = await runAiSelection(spec, {
      subject: "x",
      candidates: widgets.slice(0, 1),
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
      reasoning: "hallucinated an id",
    });
  });

  it("returns null without calling the model when there are no candidates", async () => {
    const select = vi.fn();

    const outcome = await runAiSelection(spec, {
      subject: "x",
      candidates: [],
      usage,
      ai: { select },
    });

    expect(select).not.toHaveBeenCalled();
    expect(outcome.selected).toBeNull();
    expect(outcome.confidence).toBe("low");
  });

  it("truncates candidates to maxCandidates before rendering, so a truncated id never resolves", async () => {
    const select = vi.fn(async () => ({
      selectedId: "c",
      confidence: "low" as const,
      reasoning: "picked the third one",
    }));

    const outcome = await runAiSelection(spec, {
      subject: "x",
      candidates: widgets,
      usage,
      ai: { select },
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ shortlist: "a: red\nb: blue" }),
    );
    // "c" was truncated away before the model ever saw it.
    expect(outcome.selected).toBeNull();
  });
});
