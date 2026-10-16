import type { ProjectFilters } from "@cubby/schemas/project";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { projectList } from "./lookup";

/**
 * Project filters compile from the declaration (#2410). Failure modes: the
 * effective (inherited) assignee or locations fall back to the stored column,
 * search stops reaching inherited locations, the parent filter's generated
 * sub-project toggle reads the wrong default or includes the selected parent
 * itself, or the date window stops matching a project's own dates.
 */
describe("project list declared filters", () => {
  const ctx = withTestDb();

  const world = async () => {
    const member = await createRepoEntity(ctx, "ledgerParty", {
      name: "Parity member",
      kind: "member",
    });
    const shed = await createRepoEntity(ctx, "project", {
      name: "Parity shed",
      notes: "cedar siding",
      locations: ["Backyard"],
      assigneeId: member.output.id,
    });
    const roof = await createRepoEntity(ctx, "project", {
      name: "Parity roof",
      parentProjectId: shed.output.id,
    });
    const shingles = await createRepoEntity(ctx, "project", {
      name: "Parity shingles",
      parentProjectId: roof.output.id,
    });
    const desk = await createRepoEntity(ctx, "project", {
      name: "Parity desk",
      locations: ["Office"],
      startDate: "2026-02-01",
      endDate: "2026-02-28",
    });
    return {
      member: member.output,
      shed: shed.output,
      roof: roof.output,
      shingles: shingles.output,
      desk: desk.output,
    };
  };

  it("narrows by each declared filter", async () => {
    const w = await world();
    const ids = [w.shed, w.roof, w.shingles, w.desk].map(({ id }) => id);
    const listIds = async (filters: ProjectFilters) => {
      const { data } = await projectList(ctx.db, { ...filters, ids }, [], {
        pageIndex: 0,
        pageSize: 50,
      });
      return new Set(data.map((row) => row.id));
    };
    const cases: Array<[ProjectFilters, Array<{ id: string }>]> = [
      [{ search: "cedar" }, [w.shed]],
      [{ search: "backyard" }, [w.shed, w.roof, w.shingles]],
      [{ location: ["Backyard"] }, [w.shed, w.roof, w.shingles]],
      [{ assigneeId: [w.member.id] }, [w.shed, w.roof, w.shingles]],
      [{ assigneePresenceFilter: "none" }, [w.desk]],
      [{ parentProjectPresenceFilter: "none" }, [w.shed, w.desk]],
      [{ topLevelOnly: true }, [w.shed, w.desk]],
      [{ parentProjectId: [w.shed.id] }, [w.roof]],
      [
        { parentProjectId: [w.shed.id], includeSubProjects: true },
        [w.roof, w.shingles],
      ],
      [{ dateFrom: "2026-02-10", dateTo: "2026-02-12" }, [w.desk]],
    ];
    const mismatches = [];
    for (const [filters, expected] of cases) {
      const actual = [...(await listIds(filters))].sort();
      const wanted = expected.map(({ id }) => id).sort();
      if (actual.join() !== wanted.join())
        mismatches.push({ filters, actual, wanted });
    }
    expect(mismatches).toEqual([]);
  });
});
