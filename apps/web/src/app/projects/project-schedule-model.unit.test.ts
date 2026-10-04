import type { ProjectListItemOut, ProjectOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import type { ProjectScheduleRow } from "~/lib/project-schedule";

import {
  buildPortfolioScheduleRows,
  visibleScheduleRows,
} from "./project-schedule-model";

const projectId = (seed: string) => testShortcode("project", seed);

function project(
  seed: string,
  parent?: string,
  start?: string,
  end?: string,
): ProjectOut {
  return fromPartial<ProjectOut>({
    id: projectId(seed),
    name: seed,
    status: "planning",
    parentProjectId: parent ? projectId(parent) : null,
    dates: {
      effectiveStart: start ?? null,
      effectiveEnd: end ?? null,
      startSource: start ? "explicit" : "none",
      endSource: end ? "explicit" : "none",
    },
    blockedByIds: [],
    blockingIds: [],
  });
}

describe("project schedule rows", () => {
  it("keeps an undated child under its paginated project root", () => {
    const parent = project("root", undefined, "2026-05-01", "2026-05-10");
    const child = project("child", "root");
    const rows = buildPortfolioScheduleRows(
      [
        fromPartial<ProjectListItemOut>(parent),
        fromPartial<ProjectListItemOut>(child),
      ],
      new Set(),
    );
    expect(rows.map((row) => [row.name, row.depth, row.noDateLabel])).toEqual([
      ["root", 0, undefined],
      ["child", 1, "No dates"],
    ]);
    expect(
      buildPortfolioScheduleRows(
        [
          fromPartial<ProjectListItemOut>(parent),
          fromPartial<ProjectListItemOut>(child),
        ],
        new Set([parent.id]),
      ).map((row) => row.id),
    ).toEqual([parent.id]);
  });

  it("hides a collapsed subtree of the server's rows and nothing else", () => {
    const row = (id: string, depth: number, expandable: boolean) =>
      fromPartial<ProjectScheduleRow>({ id, name: id, depth, expandable });
    const rows = [
      row("root", 0, true),
      row("phase", 1, true),
      row("work", 2, false),
      row("sibling", 1, false),
    ];
    expect(
      visibleScheduleRows(rows, new Set(["phase"])).map((entry) => entry.id),
    ).toEqual(["root", "phase", "sibling"]);
    expect(
      visibleScheduleRows(rows, new Set()).map((entry) => entry.id),
    ).toEqual(["root", "phase", "work", "sibling"]);
  });
});
