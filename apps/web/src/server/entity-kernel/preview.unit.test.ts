import type { FieldSuggestionsOut } from "@cubby/schemas/ai";
import { fromPartial } from "@total-typescript/shoehorn";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EntityKernelContext } from "./adapter";
import { previewEntity, type PreviewEntityPorts } from "./preview";

const mocks = {
  suggestFields: vi.fn<PreviewEntityPorts["suggest"]>(),
  resolveExpense: vi.fn<PreviewEntityPorts["resolveExpense"]>(),
  resolveTask: vi.fn<PreviewEntityPorts["resolveTask"]>(),
};
const ports: PreviewEntityPorts = {
  suggest: mocks.suggestFields,
  resolveExpense: mocks.resolveExpense,
  resolveTask: mocks.resolveTask,
};

describe("previewEntity field suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.suggestFields.mockImplementation(async (db, input) => {
      void db;
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
    expect(mocks.suggestFields.mock.calls.map(([, input]) => input)).toEqual(
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
});
