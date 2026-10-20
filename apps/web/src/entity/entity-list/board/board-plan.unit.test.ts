import { describe, expect, it } from "vitest";

import {
  boardGroups,
  boardGroupPage,
  boardMoveRequest,
  boardDropBefore,
} from "./board-plan";

// Failure modes: capped rows must not cap counts; group queries must retain scope,
// use independent pages, and move+rank writes must be one command body.
describe("declared board plan", () => {
  it("keeps an empty clearable group available without duplicating its real count", () => {
    const options = { noValue: true, noValueLabel: "Inbox" };
    expect(boardGroups([], null, options)).toEqual([
      { key: "__none__", label: "Inbox", count: 0 },
    ]);
    const present = [{ key: "__none__", label: "Inbox", count: 3 }];
    expect(boardGroups(present, null, options)).toEqual(present);
    expect(boardGroups([], null, { ...options, noValue: false })).toEqual([]);
  });
  const view = {
    pageSize: 50,
    caps: [{ field: "status", value: "done", limit: 20 }],
    sort: [{ orderBy: "sortOrder", direction: "asc" as const }],
    filters: { topLevelOnly: true },
    reorder: { operation: "task.bulkReorder" },
  };
  it("caps a group's cards without changing its full filtered count", () => {
    const group = { key: "done", label: "Done", count: 81 };
    const input = boardGroupPage(
      view,
      { assigneeId: ["@me"] },
      "status",
      "status",
      group,
      0,
    );
    expect(input).toMatchObject({
      filters: { assigneeId: ["@me"], topLevelOnly: true, status: ["done"] },
      pagination: { pageIndex: 0, pageSize: 20 },
    });
    expect(group.count).toBe(81);
  });
  it("uses declared cap order for every capped page", () => {
    const capped = {
      ...view,
      caps: [
        {
          field: "status",
          value: "done",
          limit: 20,
          orderBy: "updatedAt",
          direction: "asc" as const,
        },
      ],
    };
    expect(
      boardGroupPage(
        capped,
        {},
        "status",
        "status",
        { key: "done", count: 81 },
        3,
      ),
    ).toMatchObject({
      sort: [{ orderBy: "updatedAt", direction: "asc" }],
      pagination: { pageIndex: 0, pageSize: 20 },
    });
  });
  it("clears the grouping through the atomic move request", () => {
    expect(
      boardMoveRequest([], "TSK-AAAA", undefined, "projectId", "__none__"),
    ).toMatchObject({
      position: {
        id: "TSK-AAAA",
        before: null,
        after: null,
        group: { projectId: null },
      },
      move: { id: "TSK-AAAA", patch: { projectId: null } },
    });
  });
  it("pages uncapped groups independently while preserving scope", () => {
    expect(
      boardGroupPage(
        view,
        { search: "Shelf" },
        "status",
        "status",
        { key: "blocked", count: 65 },
        1,
      ),
    ).toMatchObject({
      filters: { search: "Shelf", topLevelOnly: true, status: ["blocked"] },
      pagination: { pageIndex: 1, pageSize: 50 },
    });
  });
  it("submits destination anchors and the move in one atomic command", () => {
    expect(
      boardMoveRequest(
        [{ id: "TSK-AAAA", rank: 1024 }],
        "TSK-BBBB",
        undefined,
        "status",
        "done",
      ),
    ).toEqual({
      position: {
        id: "TSK-BBBB",
        before: null,
        after: "TSK-AAAA",
        group: { status: "done" },
      },
      move: { id: "TSK-BBBB", patch: { status: "done" } },
    });
  });
});

// Pointer placement keeps both card halves reachable, while the server owns rank calculation.
describe("board placement anchors", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("inserts before the card's top half and after its bottom half", () => {
    expect(boardDropBefore(rows, "b", "top")).toBe("b");
    expect(boardDropBefore(rows, "b", "bottom")).toBe("c");
  });
  it("anchors the end of a partial page without claiming the end of its group", () => {
    expect(
      boardMoveRequest(rows, "moved", undefined, "status", "not_started")
        .position,
    ).toEqual({
      id: "moved",
      before: null,
      after: "c",
      group: { status: "not_started" },
    });
  });
});
