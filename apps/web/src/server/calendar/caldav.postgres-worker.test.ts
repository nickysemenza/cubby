import { buildActorContext } from "@cubby/schemas/context";
import { userId } from "@cubby/schemas/identifiers";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createDAVClient } from "tsdav";
import { expect, inject, it } from "vitest";

const ORIGIN = "https://calendar-postgres.example";
const event = (uid: string, title: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${title}\r\nDTSTART;VALUE=DATE:20260907\r\nDTEND;VALUE=DATE:20260908\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

it("commits tsdav CRUD through the DO and recovers a committed create after SQL publication fails", async () => {
  const stub = env.CALENDAR_FEED.getByName(new URL(ORIGIN).hostname);
  const credential = await stub.rotateCalendarCredential(
    userId.parse(inject("calendarOwnerId")),
    ORIGIN,
  );
  await stub.refreshNow("test-bootstrap", ORIGIN);
  const fetchThroughDO: typeof fetch = async (input, init) =>
    stub.fetch(new Request(input, init));
  const client = await createDAVClient({
    serverUrl: `${ORIGIN}/api/caldav/`,
    credentials: {
      username: credential.username,
      password: credential.password,
    },
    authMethod: "Basic",
    defaultAccountType: "caldav",
    fetch: fetchThroughDO,
  });
  const calendars = await client.fetchCalendars();
  const tasks = calendars.find((calendar) => calendar.url.endsWith("/tasks/"));
  if (!tasks) throw new Error("Tasks collection was not discovered");
  const created = await client.createCalendarObject({
    calendar: tasks,
    filename: "client-task.ics",
    iCalString: event("client-task", "Initial task"),
    headers: { "If-None-Match": "*" },
  });
  expect(created.status).toBe(201);
  expect(created.headers.get("etag")).toBeNull();
  const objects = await client.fetchCalendarObjects({ calendar: tasks });
  expect(objects).toHaveLength(1);
  const object = objects[0];
  if (!object?.data) throw new Error("Created task was not published");
  const updated = await client.updateCalendarObject({
    calendarObject: {
      ...object,
      data: object.data.replace("Initial task", "Renamed task"),
    },
  });
  expect(updated.status).toBe(204);
  const renamed = (await client.fetchCalendarObjects({ calendar: tasks }))[0];
  if (!renamed) throw new Error("Updated task was not published");
  expect(renamed.data).toContain("Renamed task");
  expect(
    (await client.deleteCalendarObject({ calendarObject: renamed })).status,
  ).toBe(204);
  expect(await client.fetchCalendarObjects({ calendar: tasks })).toHaveLength(
    0,
  );

  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      "CREATE TRIGGER interrupt_publication BEFORE INSERT ON calendar_resources BEGIN SELECT RAISE(FAIL, 'test interrupted publication'); END",
    );
  });
  const createRecovery = (discardedFields = "") =>
    client.createCalendarObject({
      calendar: tasks,
      filename: "recover-task.ics",
      iCalString: event("recover-task", "Recovered task").replace(
        "END:VEVENT",
        `${discardedFields}END:VEVENT`,
      ),
      headers: { "If-None-Match": "*" },
    });
  expect((await createRecovery()).status).toBe(503);
  expect((await stub.inspect(ORIGIN)).caldav?.pendingWrites).toBe(1);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
  // A normal Cubby edit can commit while CalDAV publication is recovering.
  const { db, withRequestDbClient } = await import("~/server/db");
  const { loadCalDavProjection } =
    await import("~/server/repo/calendar-caldav");
  const { updateTask } = await import("~/server/repo/task/crud");
  await withRequestDbClient(env.HYPERDRIVE.connectionString, async () => {
    const task = (await loadCalDavProjection(db)).projections.find(
      (projection) =>
        projection.entity === "task" && projection.name === "Recovered task",
    );
    if (!task || task.entity !== "task")
      throw new Error("Committed recovery task is missing");
    await updateTask(
      db,
      task.id,
      { name: "Newer Cubby name" },
      buildActorContext(userId.parse(inject("calendarOwnerId")), "ui"),
    );
  });
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("DROP TRIGGER interrupt_publication");
  });
  expect((await createRecovery("DESCRIPTION:Retry note\r\n")).status).toBe(201);
  expect((await stub.inspect(ORIGIN)).caldav?.pendingWrites).toBe(0);
  const recovered = await client.fetchCalendarObjects({ calendar: tasks });
  expect(recovered).toHaveLength(1);
  expect(recovered[0]?.data).toContain("Newer Cubby name");
});
