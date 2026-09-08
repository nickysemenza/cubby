import type { DurableObjectState } from "@cloudflare/workers-types";
import { userId } from "@cubby/schemas/identifiers";
import { testShortcode } from "@cubby/schemas/testing";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createDAVClient } from "tsdav";
import { describe, expect, it } from "vitest";

import type { CalDavResource } from "./caldav-types";
import { CalendarSqlStore } from "./sql-store";

const ORIGIN = "https://calendar-test.example";
const OWNER = userId.parse("calendar-test-user");
const subscriptionToken = "subscription-token";
const CALENDAR_PASSWORD = "calendar-test-password";
const CALENDAR_PASSWORD_DIGEST =
  "42f9b364f5962df6102e516eb8553a68ea7d73882794a60b19b32b30ce8ace6d";

const resource = {
  collection: "tasks",
  filename: "task.ics",
  uid: "task-uid@calendar-test.example",
  body: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:task-uid@calendar-test.example\r\nDTSTART;VALUE=DATE:20260907\r\nDTEND;VALUE=DATE:20260908\r\nSUMMARY:Check the filter\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  etag: '"calendar-resource-etag"',
  start: "2026-09-07T00:00:00.000Z",
  end: "2026-09-08T00:00:00.000Z",
  projection: {
    entity: "task",
    id: testShortcode("task", "calendar-worker-task"),
    name: "Check the filter",
    dueDate: "2026-09-07",
    dueEndDate: "2026-09-08",
    status: "not_started",
    updatedAt: "2026-09-07T00:00:00.000Z",
  },
} satisfies CalDavResource;

function documents() {
  const generatedAt = "2026-09-07T00:00:00.000Z";
  return {
    all: {
      body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      etag: '"all"',
      generatedAt,
      revision: 1,
      itemCount: 1,
    },
    meals: {
      body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      etag: '"meals"',
      generatedAt,
      revision: 1,
      itemCount: 0,
    },
    tasks: {
      body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      etag: '"tasks"',
      generatedAt,
      revision: 1,
      itemCount: 1,
    },
  } as const;
}

function basic(username: string, password: string) {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function request(
  pathname: string,
  init: RequestInit = {},
  authorization?: string,
) {
  const headers = new Headers(init.headers);
  if (authorization) headers.set("authorization", authorization);
  return new Request(`${ORIGIN}${pathname}`, { ...init, headers });
}

async function expectStatus(response: Promise<Response>, status: number) {
  const value = await response;
  await value.arrayBuffer();
  expect(value.status).toBe(status);
}

async function seededStub(resources: CalDavResource[] = [resource]) {
  const hostname = `calendar-${crypto.randomUUID()}.example`;
  const stub = env.CALENDAR_FEED.getByName(hostname);
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new CalendarSqlStore(state.storage);
    await store.migrate();
    store.publish(resources, documents(), ORIGIN);
  });
  return stub;
}

async function seedCredential(
  stub: ReturnType<typeof env.CALENDAR_FEED.getByName>,
) {
  const username = "calendar-test-user";
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new CalendarSqlStore(state.storage);
    store.setCredential({
      owner: OWNER,
      username,
      hash: CALENDAR_PASSWORD_DIGEST,
      createdAt: "2026-09-07T00:00:00.000Z",
    });
  });
  return { username, password: CALENDAR_PASSWORD };
}

describe("CalendarFeedDurableObject in workerd", () => {
  it("serves every CalDAV read from seeded DO SQLite without a PostgreSQL refresh", async () => {
    const stub = await seededStub();
    const credential = await seedCredential(stub);
    const authorization = basic(credential.username, credential.password);

    const options = await stub.fetch(
      request("/api/caldav/", { method: "OPTIONS" }),
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("dav")).toContain("calendar-access");

    const discovery = await stub.fetch(
      request(
        "/api/caldav/",
        { method: "PROPFIND", headers: { depth: "0" } },
        authorization,
      ),
    );
    expect(discovery.status).toBe(207);
    expect(await discovery.text()).toContain("current-user-principal");

    const home = await stub.fetch(
      request(
        "/api/caldav/calendars/me/",
        { method: "PROPFIND", headers: { depth: "1" } },
        authorization,
      ),
    );
    expect(home.status).toBe(207);
    expect(await home.text()).toContain("Cubby Completed Tasks");

    const query = await stub.fetch(
      request(
        "/api/caldav/calendars/me/tasks/",
        {
          method: "REPORT",
          headers: { "content-type": "application/xml" },
          body: `<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260907T000000Z" end="20260908T000000Z"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`,
        },
        authorization,
      ),
    );
    expect(query.status).toBe(207);
    expect(await query.text()).toContain(resource.filename);

    const multiGet = await stub.fetch(
      request(
        "/api/caldav/calendars/me/tasks/",
        {
          method: "REPORT",
          headers: { "content-type": "application/xml" },
          body: `<C:calendar-multiget xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:D="DAV:"><D:href>/api/caldav/calendars/me/tasks/${resource.filename}</D:href></C:calendar-multiget>`,
        },
        authorization,
      ),
    );
    expect(multiGet.status).toBe(207);
    expect(await multiGet.text()).toContain(resource.etag);

    const get = await stub.fetch(
      request(
        `/api/caldav/calendars/me/tasks/${resource.filename}`,
        {},
        authorization,
      ),
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("etag")).toBe(resource.etag);
    expect(await get.text()).toContain("Check the filter");

    const head = await stub.fetch(
      request(
        `/api/caldav/calendars/me/tasks/${resource.filename}`,
        { method: "HEAD", headers: { "if-none-match": resource.etag } },
        authorization,
      ),
    );
    expect(head.status).toBe(304);
    expect(await head.text()).toBe("");

    await evictDurableObject(stub);
    const afterRestart = await stub.fetch(
      request(
        `/api/caldav/calendars/me/tasks/${resource.filename}`,
        {},
        authorization,
      ),
    );
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.headers.get("etag")).toBe(resource.etag);
  });

  it("is discoverable and queryable by an independent tsdav client", async () => {
    const stub = await seededStub();
    const credential = await seedCredential(stub);
    const fetchThroughDurableObject: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      return await stub.fetch(request);
    };
    const client = await createDAVClient({
      serverUrl: `${ORIGIN}/api/caldav/`,
      credentials: {
        username: credential.username,
        password: credential.password,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
      fetch: fetchThroughDurableObject,
    });

    const calendars = await client.fetchCalendars();
    expect(calendars.map((calendar) => calendar.displayName)).toEqual(
      expect.arrayContaining([
        "Cubby Tasks",
        "Cubby Completed Tasks",
        "Cubby Meals",
      ]),
    );
    const tasks = calendars.find(
      (calendar) => calendar.displayName === "Cubby Tasks",
    );
    expect(tasks).toBeDefined();
    const objects = await client.fetchCalendarObjects({ calendar: tasks! });
    expect(objects).toHaveLength(1);
    expect(objects[0]?.data).toContain("Check the filter");
  });

  it("answers Calendar.app's account-root principal and home discovery request", async () => {
    const stub = await seededStub();
    const credential = await seedCredential(stub);
    const response = await stub.fetch(
      request(
        "/api/caldav/",
        {
          method: "PROPFIND",
          headers: { depth: "0", "content-type": "application/xml" },
          // Calendar.app sends a property-selection body with independently
          // prefixed DAV and CalDAV namespaces at the account root.
          body: `<A:propfind xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:caldav" xmlns:O="urn:calendar:optional"><A:prop><A:current-user-principal/><B:calendar-home-set/><A:principal-URL/><O:color/></A:prop></A:propfind>`,
        },
        basic(credential.username, credential.password),
      ),
    );
    const body = await response.text();
    expect(response.status).toBe(207);
    expect(body).toContain("/api/caldav/principals/me/");
    expect(body).toContain("/api/caldav/calendars/me/");
    expect(body).toContain("HTTP/1.1 404 Not Found");
    expect(body).toContain("urn:calendar:optional");
  });

  it("keeps a credential revocable and returns initializing reads without touching PostgreSQL", async () => {
    const stub = env.CALENDAR_FEED.getByName(
      `calendar-${crypto.randomUUID()}.example`,
    );
    const credential = await seedCredential(stub);
    const authorization = basic(credential.username, credential.password);

    const initializing = await stub.fetch(
      request("/api/caldav/calendars/me/tasks/anything.ics", {}, authorization),
    );
    expect(initializing.status).toBe(503);

    await stub.revokeCalendarCredential(OWNER);
    const revoked = await stub.fetch(
      request("/api/caldav/calendars/me/tasks/anything.ics", {}, authorization),
    );
    expect(revoked.status).toBe(401);
  });

  it("serves subscription documents from SQLite and never initializes them through PostgreSQL", async () => {
    const stub = await seededStub();
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new CalendarSqlStore(state.storage);
      store.setToken(subscriptionToken);
    });

    await expect(stub.read("unknown-token", "tasks", null)).resolves.toEqual({
      result: "not_found",
    });
    await expect(
      stub.read(subscriptionToken, "tasks", null),
    ).resolves.toMatchObject({
      result: "served",
      etag: documents().tasks.etag,
      body: documents().tasks.body,
    });
    await expect(
      stub.read(subscriptionToken, "tasks", documents().tasks.etag),
    ).resolves.toMatchObject({
      result: "not_modified",
      etag: documents().tasks.etag,
    });

    const noDocumentStub = env.CALENDAR_FEED.getByName(
      `calendar-${crypto.randomUUID()}.example`,
    );
    await runInDurableObject(noDocumentStub, async (_instance, state) => {
      const store = new CalendarSqlStore(state.storage);
      await store.migrate();
      store.setToken(subscriptionToken);
    });
    await expect(
      noDocumentStub.read(subscriptionToken, "tasks", null),
    ).resolves.toEqual({ result: "unavailable" });
  });

  it("blocks uncertain writes without changing published resources", async () => {
    const stub = await seededStub();
    const credential = await seedCredential(stub);
    const authorization = basic(credential.username, credential.password);
    const target = `/api/caldav/calendars/me/tasks/${resource.filename}`;
    const put = async (headers: HeadersInit, body = resource.body) =>
      await stub.fetch(
        request(target, { method: "PUT", headers, body }, authorization),
      );

    await expectStatus(put({ "if-match": '"stale"' }), 412);
    await expectStatus(put({ "if-none-match": "*" }), 412);
    await expectStatus(put({ "if-match": resource.etag }), 503);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect((await stub.inspect(ORIGIN)).caldav?.uncertainWrites).toMatchObject([
      {
        collection: "tasks",
        filename: resource.filename,
        shortcode: resource.projection.id,
      },
    ]);

    const blocked = await put({ "if-match": resource.etag });
    expect(blocked.status).toBe(503);
    expect(await blocked.text()).toContain("uncertain write");
    await expectStatus(stub.fetch(request(target, {}, authorization)), 200);

    await evictDurableObject(stub);
    expect((await stub.inspect(ORIGIN)).caldav?.uncertainWrites).toHaveLength(
      1,
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new CalendarSqlStore(state.storage);
      store.publish([resource], documents(), ORIGIN);
      expect(store.uncertainWrites()).toHaveLength(1);
      expect(store.identities()).toContainEqual({
        entity: "task",
        shortcode: resource.projection.id,
        filename: resource.filename,
        uid: resource.uid,
      });
    });

    await stub.clearUncertainWrite("tasks", resource.filename);
    expect((await stub.inspect(ORIGIN)).caldav?.uncertainWrites).toEqual([]);
    await expectStatus(stub.fetch(request(target, {}, authorization)), 200);
    await expectStatus(put({ "if-match": resource.etag }), 503);
  });

  it("keeps publication atomic and identities durable across the cutover reset", async () => {
    const stub = await seededStub();

    await runInDurableObject(
      stub,
      async (_instance, state: DurableObjectState) => {
        const store = new CalendarSqlStore(state.storage);
        const duplicate = { ...resource, filename: "duplicate.ics" };
        expect(() =>
          store.publish([resource, duplicate], documents(), ORIGIN),
        ).toThrow(/UNIQUE constraint failed/i);
        expect(store.meta().generation).toBe(1);
        expect(store.list("tasks")).toHaveLength(1);
        await store.migrate();
        expect(store.list("tasks")).toHaveLength(1);
        store.publish([], documents(), ORIGIN);
        expect(store.identities()).toContainEqual({
          entity: "task",
          shortcode: resource.projection.id,
          filename: resource.filename,
          uid: resource.uid,
        });
        const completed: CalDavResource = {
          ...resource,
          collection: "completed-tasks" as const,
          projection: {
            entity: "task",
            id: resource.projection.id,
            name: resource.projection.name,
            dueDate: resource.projection.dueDate,
            dueEndDate: resource.projection.dueEndDate,
            status: "done",
            updatedAt: resource.projection.updatedAt,
          },
        };
        store.publish([completed], documents(), ORIGIN);
        expect(store.list("completed-tasks")).toHaveLength(1);
        expect(store.identities()).toHaveLength(1);
        const indexes = state.storage.sql
          .exec<{ name: string }>("PRAGMA index_list('calendar_resources')")
          .toArray()
          .map((row) => String(row.name));
        expect(indexes).toContain("calendar_resource_dates");
      },
    );
  });
});
