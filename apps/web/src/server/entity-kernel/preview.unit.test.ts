import type { FieldSuggestionsOut } from "@cubby/schemas/ai";
import { runEntityId } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EntityKernelContext } from "./adapter";
import { previewEntity, type PreviewEntityPorts } from "./preview";

const fixtureRunId = runEntityId.parse("00000000-0000-4000-8000-000000000001");

const mocks = {
  suggestFields: vi.fn<PreviewEntityPorts["suggest"]>(),
  resolveExpense: vi.fn<PreviewEntityPorts["resolveExpense"]>(),
  resolveTask: vi.fn<PreviewEntityPorts["resolveTask"]>(),
  ensureRun: vi.fn<PreviewEntityPorts["ensureRun"]>(),
};
const ports: PreviewEntityPorts = {
  suggest: mocks.suggestFields,
  resolveExpense: mocks.resolveExpense,
  resolveTask: mocks.resolveTask,
  ensureRun: mocks.ensureRun,
};

describe("previewEntity field suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRun.mockResolvedValue(fixtureRunId);
  });

  it("detects adjustment drafts before requesting project suggestions", async () => {
    mocks.resolveExpense.mockResolvedValue({});
    mocks.suggestFields.mockResolvedValue({ suggestions: {} });
    await previewEntity(
      fromPartial<EntityKernelContext>({ db: {} }),
      {
        entity: "expense",
        data: { name: "Sales tax", lineKind: "auto" },
        context: { suggest: true, targets: ["projectId"] },
      },
      ports,
    );
    expect(mocks.resolveExpense).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineKind: "tax" }),
    );
    expect(mocks.suggestFields).not.toHaveBeenCalled();
  });

  it("autofills only unresolved inherited targets and reviews explicit None in a provided batch", async () => {
    const fieldResolutions = {
      projectId: {
        mode: "none" as const,
        storedValue: null,
        value: null,
        fallbackValue: "PRJ-PARENT",
        source: "Task override",
        sourceEntity: null,
        matchesFallback: false,
        canReset: true,
      },
      trade: {
        mode: "inherit" as const,
        storedValue: null,
        value: null,
        fallbackValue: null,
        source: "No trade source",
        sourceEntity: null,
        matchesFallback: true,
        canReset: false,
      },
    };
    mocks.resolveTask.mockImplementation(async (db, draft) => {
      void db;
      return draft.trade
        ? {
            ...fieldResolutions,
            trade: {
              ...fieldResolutions.trade,
              mode: "explicit" as const,
              storedValue: draft.trade,
              value: draft.trade,
              source: "Task override",
            },
          }
        : fieldResolutions;
    });
    mocks.suggestFields.mockImplementation(async (db, runId, input) => {
      void db;
      void runId;
      expect(input.basis).toMatchObject({
        parentTaskId: null,
        projectId: null,
        projectMode: "explicit",
        trade: null,
      });
      expect(input.basis.__resolutionContext).toBe(
        JSON.stringify(fieldResolutions),
      );
      const suggestions: FieldSuggestionsOut["suggestions"] =
        input.basisMode === "suggested"
          ? {
              trade: {
                value: "electrical",
                label: "Electrical",
                detail: null,
                confidence: "high" as const,
                probability: 0.95,
                reasoning: "Panel work",
                alternatives: [],
                operation: "set" as const,
                removals: [],
              },
            }
          : {
              projectId: {
                value: "PRJ-OTHER",
                label: "Other project",
                detail: null,
                confidence: "high" as const,
                probability: 0.95,
                reasoning: "Possible alternative",
                alternatives: [],
                operation: "set" as const,
                removals: [],
              },
            };
      return { suggestions };
    });

    const result = await previewEntity(
      fromPartial<EntityKernelContext>({}),
      {
        entity: "task",
        data: {
          name: "Replace electrical panel",
          projectId: null,
          projectMode: "explicit",
        },
        context: { targets: ["projectId", "trade"] },
      },
      ports,
    );

    expect(mocks.suggestFields).toHaveBeenCalledTimes(2);
    expect(mocks.suggestFields.mock.calls.map(([, , input]) => input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          basisMode: "suggested",
          targets: ["trade"],
        }),
        expect.objectContaining({
          basisMode: "provided",
          targets: ["projectId"],
        }),
      ]),
    );
    expect(result.proposed.trade).toBe("electrical");
    expect(result.proposed.projectId).toBeNull();
    expect(result.suggestions.trade?.applied).toBe(true);
    expect(result.suggestions.projectId?.applied).toBe(false);
    expect(result.canCommit).toBe(true);
  });

  it("cannot commit a task preview with no effective trade", async () => {
    mocks.resolveTask.mockResolvedValue({
      trade: {
        mode: "inherit",
        storedValue: null,
        value: null,
        fallbackValue: null,
        source: "No trade source",
        sourceEntity: null,
        matchesFallback: true,
        canReset: false,
      },
    });
    mocks.suggestFields.mockResolvedValue({ suggestions: { trade: null } });

    const result = await previewEntity(
      fromPartial<EntityKernelContext>({}),
      {
        entity: "task",
        data: { name: "Inspect unknown work" },
        context: { targets: ["trade"] },
      },
      ports,
    );

    expect(result.canCommit).toBe(false);
    expect(result.errors).toContainEqual({
      path: ["trade"],
      message:
        "No effective trade is available from this record or its inheritance sources.",
    });
  });

  it("never auto-applies a high-confidence tag-prune (remove) suggestion", async () => {
    mocks.resolveExpense.mockResolvedValue({});
    mocks.resolveTask.mockResolvedValue({});
    mocks.suggestFields.mockResolvedValue({
      suggestions: {
        tags: {
          value: "jacquemus",
          label: "Remove jacquemus",
          detail: "restates manufacturer",
          confidence: "high" as const,
          probability: 1,
          reasoning: "",
          alternatives: [],
          operation: "remove" as const,
          removals: [
            {
              value: "jacquemus",
              probability: 1,
              reason: "restates manufacturer",
            },
          ],
        },
      },
    });

    const result = await previewEntity(
      fromPartial<EntityKernelContext>({}),
      {
        entity: "product",
        data: { name: "Widget" },
        context: { targets: ["tags"] },
      },
      ports,
    );

    // `tags` has no explicit value and no inheritance resolution, so this
    // target runs in "suggested" mode — the one basisMode that auto-applies
    // a plain `set` suggestion at high confidence. A `remove` suggestion must
    // stay excluded from that regardless: its `value` is a joined removal
    // string, never a valid replacement for the field.
    expect(mocks.suggestFields.mock.calls[0]?.[2]).toMatchObject({
      basisMode: "suggested",
      targets: ["tags"],
    });
    expect(result.suggestions.tags?.applied).toBe(false);
    expect(result.proposed.tags).not.toBe("jacquemus");
  });
});
