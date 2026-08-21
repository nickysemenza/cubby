import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commit = vi.fn();

vi.mock("./use-entity-commands", () => ({
  useEntityCommands: () => ({
    isPending: false,
    issues: [],
    commit,
  }),
}));

import { useEntityEditSession } from "./use-entity-edit-session";

const request = (name = "saved") => ({
  entity: "task" as const,
  operation: "update" as const,
  intent: "schedule" as const,
  surface: "calendar" as const,
  record: {
    id: "TSK-SESSION",
    name,
    status: "not_started" as const,
    dueDate: "2026-08-20",
    dueEndDate: null,
  },
});

describe("useEntityEditSession", () => {
  beforeEach(() => {
    commit.mockReset();
  });

  it("keeps a draft through an equivalent inline request and resets for record changes", () => {
    const { result, rerender } = renderHook(
      ({ name }) => useEntityEditSession(request(name)),
      { initialProps: { name: "saved" } },
    );

    act(() => result.current.set("name", "draft name"));
    expect(result.current.values.name).toBe("draft name");

    rerender({ name: "saved" });
    expect(result.current.values.name).toBe("draft name");

    rerender({ name: "server refresh" });
    expect(result.current.values.name).toBe("server refresh");
  });

  it("does not report an untouched array field as changed after RHF clones it", async () => {
    commit.mockResolvedValue({
      ok: true,
      entity: "financialAccount",
      id: "FAC-SESSION",
      changed: false,
    });
    const sourceAliases = [
      { source: "statement", alias: "Primary card", externalAccountId: null },
    ];
    const { result } = renderHook(() =>
      useEntityEditSession({
        entity: "financialAccount",
        operation: "update",
        intent: "full",
        surface: "dialog",
        record: {
          id: "FAC-SESSION",
          name: "Household card",
          provisional: false,
          sourceAliases,
          notes: null,
        },
      }),
    );

    await act(() => result.current.submit());

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        changed: false,
        command: expect.objectContaining({ data: {} }),
      }),
    );

    commit.mockClear();
    act(() => result.current.set("name", "Renamed card"));
    await act(() => result.current.submit());

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        changed: true,
        command: expect.objectContaining({ data: { name: "Renamed card" } }),
      }),
    );
  });
});
