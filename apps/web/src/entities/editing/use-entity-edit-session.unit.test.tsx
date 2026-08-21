import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
});
