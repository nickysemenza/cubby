import type { DurableObjectState } from "@cloudflare/workers-types";
import { userId, type UserId } from "@cubby/schemas/identifiers";
import { DurableObject } from "cloudflare:workers";

import { runWithExecutionCtx, setCfEnv } from "~/server/cf-env";
import { recordDatabaseWrite } from "~/server/database-freshness/client";
import { withTrace } from "~/server/tracing";

import { authenticateCalendar, calendarDigest } from "./caldav-auth";
import {
  CalDavError,
  type CalDavBackend,
  type CalDavWrite,
} from "./caldav-types";
import {
  createCalendarFeedToken,
  etagMatches,
  inspectCalendarDocument,
  UID_DOMAIN,
  type CalendarFeedReadResult,
  type CalendarFeedDurableObjectRpc,
} from "./contracts";
import type { IcsFeed } from "./ics";
import { CalendarSqlStore } from "./sql-store";

type WriteResponse = Awaited<ReturnType<CalDavBackend["write"]>>;

const DIRTY_DELAY_MS = 2_000;

export class CalendarFeedDurableObject
  extends DurableObject<Env>
  implements CalendarFeedDurableObjectRpc
{
  private readonly store: CalendarSqlStore;
  private publicationTail: Promise<void> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new CalendarSqlStore(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await this.store.migrate();
      if (!this.store.meta().generation && env.APP_ORIGIN)
        await this.markDirty("initialize", env.APP_ORIGIN);
      // Clean cutover: old subscription credentials and documents are disposable.
      await ctx.storage.delete([
        "calendar:meta",
        "calendar:dirty",
        "calendar:feed:meals",
        "calendar:feed:tasks",
        "calendar:feed:all",
      ]);
    });
  }
  async fetch(request: Request) {
    const origin = new URL(request.url).origin;
    const backend: CalDavBackend = {
      authenticate: (authorization) =>
        authenticateCalendar(this.store, authorization),
      ready: () => this.store.meta().generation > 0,
      list: (collection, range) => this.store.list(collection, range),
      get: (collection, filename) => this.store.get(collection, filename),
      write: (input) =>
        this.serializePublication(() => this.write(input, origin)),
    };
    const { createCalDavHandler } = await import("./caldav-http");
    return createCalDavHandler(backend)(request);
  }
  async getToken() {
    return this.store.meta().token;
  }
  async getCalendarCredential(owner: UserId) {
    const value = this.store.credential(userId.parse(owner));
    return {
      configured: Boolean(value),
      username: value?.username ?? "",
      createdAt: value?.createdAt ?? null,
    };
  }
  async rotateCalendarCredential(owner: UserId, origin: string) {
    const id = userId.parse(owner);
    const existing = this.store.credential(id);
    const username =
      existing?.username ?? `calendar-${crypto.randomUUID().slice(0, 8)}`;
    const password = createCalendarFeedToken();
    const createdAt = new Date().toISOString();
    this.store.setCredential({
      owner: id,
      username,
      hash: await calendarDigest(password),
      createdAt,
    });
    await this.markDirty("credential-created", origin);
    return { username, password, createdAt };
  }
  async revokeCalendarCredential(owner: UserId) {
    this.store.revokeCredential(userId.parse(owner));
  }
  async inspect(origin: string) {
    const meta = this.store.meta();
    const alarm = await this.ctx.storage.getAlarm();
    return {
      schemaVersion: 1 as const,
      inspectedAt: new Date().toISOString(),
      runtime: "durable-object" as const,
      origin,
      object: {
        id: this.ctx.id.toString(),
        jurisdiction: this.ctx.id.jurisdiction ?? null,
      },
      tokenConfigured: Boolean(meta.token),
      snapshot: meta.generation
        ? { revision: meta.generation, generatedAt: meta.generatedAt }
        : null,
      dirty: meta.dirtyReason
        ? { reason: meta.dirtyReason, sequence: meta.dirtySequence }
        : null,
      alarmAt: alarm === null ? null : new Date(alarm).toISOString(),
      feeds: {
        meals: inspectCalendarDocument(this.store.document("meals")),
        tasks: inspectCalendarDocument(this.store.document("tasks")),
        all: inspectCalendarDocument(this.store.document("all")),
      },
      caldav: {
        ready: meta.generation > 0,
        counts: this.store.counts(),
        uncertainWrites: this.store
          .uncertainWrites()
          .map(({ entity: _entity, uid: _uid, ...marker }) => marker),
        refreshFailedAt: meta.refreshFailedAt,
      },
    };
  }
  async rotate(origin: string) {
    return this.serializePublication(async () => {
      try {
        await this.refresh(origin, "rotate");
      } catch {
        throw new Error(
          "Calendar could not refresh. Try again shortly; existing connections are unchanged.",
        );
      }
      const token = createCalendarFeedToken();
      this.store.setToken(token);
      return token;
    });
  }
  async read(
    token: string,
    feed: IcsFeed,
    ifNoneMatch: string | null,
  ): Promise<CalendarFeedReadResult> {
    if (token !== this.store.meta().token) return { result: "not_found" };
    const document = this.store.document(feed);
    if (!document) return { result: "unavailable" };
    return etagMatches(ifNoneMatch, document.etag)
      ? { result: "not_modified", ...document }
      : { result: "served", ...document };
  }
  async markDirty(reason: string, origin: string) {
    this.store.dirty(reason, origin);
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + DIRTY_DELAY_MS);
  }
  async refreshNow(reason: string, origin: string) {
    return this.serializePublication(async () => {
      return this.refresh(origin, reason);
    });
  }
  async alarm() {
    const meta = this.store.meta();
    if (!meta.origin) return;
    try {
      await this.refreshNow(meta.dirtyReason ?? "reconcile", meta.origin);
    } catch (error) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      throw error;
    }
    if (this.store.meta().dirtyReason)
      await this.ctx.storage.setAlarm(Date.now() + DIRTY_DELAY_MS);
  }
  private async withDatabase<T>(
    run: (db: import("~/server/db").Database) => Promise<T>,
    origin: string,
  ) {
    if (!this.env.HYPERDRIVE?.connectionString)
      throw new Error("Calendar PostgreSQL write backend is unavailable");
    setCfEnv(this.env);
    const { db, withRequestDbClient } = await import("~/server/db");
    return runWithExecutionCtx(
      { waitUntil: (task) => this.ctx.waitUntil(task) },
      () =>
        withRequestDbClient(this.env.HYPERDRIVE.connectionString, () =>
          run(db),
        ),
      origin,
    );
  }
  private async refresh(origin: string, reason: string) {
    try {
      return await this.publishProjection(origin, reason);
    } catch (error) {
      this.store.refreshFailed();
      throw error;
    }
  }
  async clearUncertainWrite(
    collection: import("./caldav-types").CalDavCollection,
    filename: string,
  ) {
    return this.serializePublication(async () => {
      this.store.clearUncertainWrite(collection, filename);
    });
  }
  private async publishProjection(origin: string, reason: string) {
    const sequence = this.store.meta().dirtySequence;
    return withTrace(
      "calendar.feed.refresh",
      async () => {
        const { resources, snapshot } = await this.withDatabase(async (db) => {
          const [
            { loadCalDavProjection },
            { buildCalendarSnapshot },
            { renderCalDavResource },
          ] = await Promise.all([
            import("~/server/repo/calendar-caldav"),
            import("./snapshot"),
            import("./caldav-ics"),
          ]);
          const data = await loadCalDavProjection(db);
          const identityByCode = new Map(
            this.store
              .identities()
              .map((identity) => [identity.shortcode, identity]),
          );
          const resources = await Promise.all(
            data.projections.map((projection) =>
              renderCalDavResource(
                projection,
                identityByCode.get(projection.id) ?? {
                  entity: projection.entity,
                  shortcode: projection.id,
                  filename: `${projection.id}.ics`,
                  uid: `${projection.id}@${UID_DOMAIN}`,
                },
                origin,
              ),
            ),
          );
          const snapshot = await buildCalendarSnapshot(db, {
            origin,
            now: new Date(),
            revision: this.store.meta().generation + 1,
          });
          return { resources, snapshot };
        }, origin);
        const revision = this.store.publish(
          resources,
          snapshot.documents,
          origin,
        );
        this.store.clearDirty(sequence);
        return {
          generatedAt: snapshot.generatedAt,
          revision,
          counts: snapshot.counts,
        };
      },
      { "cubby.calendar.refresh_reason": reason },
    );
  }
  private async execute(write: CalDavWrite, origin: string) {
    return this.withDatabase(async (db) => {
      const { executeCalDavWrite } =
        await import("~/server/repo/calendar-caldav");
      return executeCalDavWrite(db, write);
    }, origin);
  }
  private async write(
    input: Parameters<CalDavBackend["write"]>[0],
    origin: string,
  ) {
    const entity = input.collection === "meals" ? "meal" : "task";
    if (
      this.store
        .uncertainWrites()
        .some(
          (marker) =>
            (marker.entity === entity && marker.filename === input.filename) ||
            marker.uid === input.event.uid,
        )
    )
      throw new CalDavError(
        503,
        "This event has an uncertain write. Check the record in Cubby, then clear the marker in Calendar state.",
      );
    const expected = this.store.get(input.collection, input.filename);
    this.checkWriteConditions(input, expected);
    if (!expected && this.store.identityAt(entity, input.filename))
      throw new CalDavError(
        403,
        "Calendar resource identity is reserved",
        "no-uid-conflict",
      );
    this.store.startWrite({
      entity,
      collection: input.collection,
      filename: input.filename,
      uid: input.event.uid,
      shortcode: expected?.projection.id ?? null,
      startedAt: new Date().toISOString(),
    });
    const write: CalDavWrite = {
      actorId: input.actorId,
      collection: input.collection,
      filename: input.filename,
      expected,
      event: input.event,
    };
    let committed = false;
    try {
      await this.markDirty("caldav-write", origin);
      const result = await this.execute(write, origin).finally(() =>
        recordDatabaseWrite("caldav.write"),
      );
      committed = true;
      this.store.rememberIdentity({
        entity,
        shortcode: result.shortcode,
        filename: input.filename,
        uid: input.event.uid,
      });
      await this.refresh(origin, "caldav-write");
      this.store.clearUncertainWrite(input.collection, input.filename);
    } catch (error) {
      // Only known precommit rejections can release a marker automatically.
      if (!committed && error instanceof CalDavError && error.status < 500)
        this.store.clearUncertainWrite(input.collection, input.filename);
      throw error;
    }
    const resource = this.store.get(input.collection, input.filename);
    const result: WriteResponse = { status: expected ? 204 : 201 };
    if (resource && resource.body === input.body) result.etag = resource.etag;
    return result;
  }
  private checkWriteConditions(
    input: Parameters<CalDavBackend["write"]>[0],
    expected: ReturnType<CalendarSqlStore["get"]>,
  ) {
    if (expected) {
      if (input.ifNoneMatch === "*")
        throw new CalDavError(412, "Calendar event already exists");
      if (!input.ifMatch) throw new CalDavError(428, "If-Match is required");
      const tags = input.ifMatch.split(",").map((value) => value.trim());
      // RFC 7232 §3.1: "*" matches any current representation, not just a
      // literal etag — same rule etagMatches already applies to If-None-Match.
      if (!tags.includes("*") && !tags.includes(expected.etag))
        throw new CalDavError(412, "Calendar event has changed");
      if (input.event.uid !== expected.uid)
        throw new CalDavError(403, "UID cannot change", "no-uid-conflict");
    } else {
      if (input.ifMatch)
        throw new CalDavError(412, "Calendar event no longer exists");
      if (input.ifNoneMatch !== "*")
        throw new CalDavError(428, "If-None-Match: * is required");
      if (this.store.byUid(input.event.uid))
        throw new CalDavError(403, "UID already exists", "no-uid-conflict");
    }
  }
  private async serializePublication<T>(run: () => Promise<T>) {
    const result = this.publicationTail.then(run, run);
    this.publicationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
