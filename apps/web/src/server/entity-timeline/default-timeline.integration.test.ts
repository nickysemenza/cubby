import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { taskCreateInput } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { parseEntityTimelineInput } from "~/entities/generated/entity-timelines.gen";
import { householdLocalDate } from "~/lib/household-date";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { createTestRequestContext } from "~/server/testing/request-context";

import { defaultTimeline, TIMELINE_ROW_CAP } from "./default-timeline";

const createdTask = async (
  context: ReturnType<typeof entityKernelContextSchema.parse>,
  data: { name: string; dueDate?: string; dueEndDate?: string },
) => {
  const result = await executeEntity(context, {
    action: "create",
    entity: "task",
    data: taskCreateInput.parse({ trade: "other", ...data }),
  });
  if (result.action !== "create") throw new Error("expected a create result");
  return parseShortcodeFor("task", result.item.id);
};

/**
 * The shared timeline correlates audit rows (uuids) with the list scope
 * (shortcodes) and adds the declared date fields; a wrong join direction or
 * a window applied to one source but not the other would pass typecheck.
 */
describe("default entity timeline", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
  const timeline = (
    window: Parameters<typeof parseEntityTimelineInput<"task">>[1]["window"],
  ) =>
    defaultTimeline(
      context(),
      parseEntityTimelineInput("task", { entity: "task", filters: {}, window }),
    );

  it("emits audit and declared-date events for the scope, ordered and windowed as asked", async () => {
    const today = householdLocalDate();
    const first = await createdTask(context(), {
      name: "Timeline first",
      dueDate: "2026-02-10",
      dueEndDate: "2026-02-12",
    });
    const second = await createdTask(context(), {
      name: "Timeline second",
      dueDate: "2026-05-01",
    });
    await executeEntity(context(), {
      action: "update",
      entity: "task",
      id: first,
      data: { name: "Timeline first renamed" },
    });

    const desc = await timeline({ order: "desc" });
    expect(desc.groups.map((group) => group.date)).toEqual([
      today,
      "2026-05-01",
      "2026-02-12",
      "2026-02-10",
    ]);
    const todayEvents = desc.groups[0]!.events.map((event) => ({
      kind: event.kind,
      label: event.label,
      detail: event.detail,
      link: event.link,
    }));
    expect(todayEvents).toEqual(
      expect.arrayContaining([
        {
          kind: "audit:create",
          label: "Timeline first renamed",
          detail: "Created",
          link: { entity: "task", id: first },
        },
        {
          kind: "audit:update",
          label: "Timeline first renamed",
          detail: "Updated Name",
          link: { entity: "task", id: first },
        },
        {
          kind: "audit:create",
          label: "Timeline second",
          detail: "Created",
          link: { entity: "task", id: second },
        },
      ]),
    );
    expect(desc.groups[1]!.events).toEqual([
      expect.objectContaining({
        kind: "field:dueDate",
        detail: "Due",
        link: { entity: "task", id: second },
      }),
    ]);
    expect(desc.extent).toEqual({ from: "2026-02-10", to: today });
    expect(desc.stats).toEqual(
      expect.arrayContaining([
        { key: "records", label: "Records", value: "2" },
        { key: "audit", label: "Audit entries", value: "3" },
      ]),
    );
    expect(desc.notes).toEqual([]);

    const asc = await timeline({ order: "asc" });
    expect(asc.groups.map((group) => group.date)).toEqual([
      "2026-02-10",
      "2026-02-12",
      "2026-05-01",
      today,
    ]);

    // The window bounds both sources: today's audit rows fall outside it.
    const windowed = await timeline({
      order: "asc",
      from: "2026-02-11",
      to: "2026-06-01",
    });
    expect(
      windowed.groups.flatMap((group) =>
        group.events.map((event) => [group.date, event.kind]),
      ),
    ).toEqual([
      ["2026-02-12", "field:dueEndDate"],
      ["2026-05-01", "field:dueDate"],
    ]);
    expect(windowed.extent).toEqual({ from: "2026-02-12", to: "2026-05-01" });

    // `ids` narrows to the named records without touching the list filters.
    const narrowed = await timeline({ order: "desc", ids: [second] });
    expect(
      narrowed.groups.flatMap((group) => group.events.map((e) => e.link?.id)),
    ).toEqual([second, second]);
    expect(narrowed.stats).toEqual(
      expect.arrayContaining([
        { key: "records", label: "Records", value: "1" },
      ]),
    );
  });

  it("builds lifecycle rows from the declared start, milestones, and end keys", async () => {
    const today = householdLocalDate();
    const dated = await createdTask(context(), {
      name: "Lifecycle task",
      dueDate: "2026-03-03",
      dueEndDate: "2026-03-09",
    });
    const undated = await createdTask(context(), { name: "Undated task" });

    const out = await timeline({ order: "asc" });
    const rows = new Map(out.rows?.map((row) => [row.id, row]));
    expect(rows.get(dated)).toEqual({
      id: dated,
      name: "Lifecycle task",
      imageUrl: null,
      link: { entity: "task", id: dated },
      intervals: [{ start: today, end: "2026-03-09", confident: true }],
      markers: expect.arrayContaining([
        expect.objectContaining({ date: today, kind: "field:createdAt" }),
        expect.objectContaining({ date: "2026-03-03", kind: "field:dueDate" }),
        expect.objectContaining({
          date: "2026-03-09",
          kind: "field:dueEndDate",
        }),
      ]),
    });
    // `createdAt` always dates the row, so an otherwise undated record still
    // gets a lifecycle that starts today and stays open.
    expect(rows.get(undated)?.intervals).toEqual([
      { start: today, end: null, confident: true },
    ]);
  });

  it("caps the scope at the row cap and says so in both notes and stats", async () => {
    const db = ctx.db;
    for (let index = 0; index <= TIMELINE_ROW_CAP; index += 1) {
      await insertWithShortcode(db, "task", {
        name: `Filler ${index}`,
        status: "not_started",
        trade: "other",
      });
    }
    const out = await timeline({ order: "desc" });
    expect(out.notes).toEqual([
      `Showing the newest ${TIMELINE_ROW_CAP} of ${TIMELINE_ROW_CAP + 1} matching records; narrow the filters to see the rest.`,
    ]);
    expect(out.stats).toEqual(
      expect.arrayContaining([
        {
          key: "records",
          label: "Records",
          value: `${TIMELINE_ROW_CAP} of ${TIMELINE_ROW_CAP + 1}`,
        },
      ]),
    );
    expect(out.rows).toHaveLength(TIMELINE_ROW_CAP);
  });
});
