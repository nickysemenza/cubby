import type { ReadableFieldEnvelope } from "@cubby/schemas/field-envelope";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { testShortcode } from "@cubby/schemas/testing";
import { renderHook } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, it, vi } from "vitest";

import { createEditorBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { overrideOperationDispatch } from "~/integrations/tanstack-query/operation-call";
import type { CubbyRow } from "~/ui/data-table/table-features";

import { useRedundantOverrideBulkAction } from "./field-resolution";

it.each([true, false])(
  "loads a current preview before bulk reset (matching=%s)",
  async (matches) => {
    const harness = createEditorBrowserTestHarness();
    const value = testShortcode("project", "synthetic-bulk-project");
    const envelope: ReadableFieldEnvelope = {
      current: {
        assignment: { kind: "value", value, ownership: { kind: "record" } },
        controls: {
          kind: "editable",
          canSetNone: false,
          canConfirm: false,
          reset: { kind: "available", preview: { kind: "not_loaded" } },
        },
      },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value },
          provenance: { kind: "own", ownership: { kind: "record" } },
        },
      },
      work: { kind: "idle" },
    };
    const record = {
      id: testShortcode("expense", "synthetic-bulk-expense"),
      fields: { projectId: envelope },
    };
    const dispatch = vi.fn<Parameters<typeof overrideOperationDispatch>[0]>(
      async () => ({
        ok: true,
        data: {
          action: "update",
          entity: "expense",
          item: { id: record.id },
          appliedFields: ["projectId"],
          sideEffects: {},
        },
      }),
    );
    const restoreDispatch = overrideOperationDispatch(dispatch);
    const row = fromPartial<CubbyRow<typeof record>>({ original: record });
    const preview = fromPartial<FieldExplanationOutput>({
      envelope: {
        ...envelope,
        current: {
          ...envelope.current,
          controls: {
            kind: "editable",
            canSetNone: false,
            canConfirm: false,
            reset: {
              kind: "available",
              preview: {
                kind: "ready",
                result: {
                  kind: "live",
                  decision: {
                    outcome: {
                      kind: "value",
                      value: matches
                        ? value
                        : testShortcode("project", "different-bulk-project"),
                    },
                    provenance: null,
                  },
                },
              },
            },
          },
        },
      },
    });
    const fetch = vi
      .spyOn(harness.queryClient, "fetchQuery")
      .mockResolvedValue(preview);
    try {
      const { result } = renderHook(
        () => useRedundantOverrideBulkAction<typeof record>("expense"),
        { wrapper: harness.wrapper },
      );
      const action = result.current;
      if (!action) throw new Error("Missing inherited-values action");
      expect(action.availability?.([row])).toEqual({ status: "available" });
      expect(fetch).not.toHaveBeenCalled();
      expect(await action.onExecute([row])).toEqual({ success: matches });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(matches ? 1 : 0);
      const accepted = expect.objectContaining({
        action: "update",
        id: record.id,
        data: { projectId: null },
      });
      expect(dispatch.mock.calls.map((call) => call[1])).toEqual(
        matches ? [accepted] : [],
      );
    } finally {
      fetch.mockRestore();
      restoreDispatch();
      harness.dispose();
    }
  },
);
