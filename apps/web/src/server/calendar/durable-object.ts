import type { DurableObjectState } from "@cloudflare/workers-types";
import { userId, type UserId } from "@cubby/schemas/identifiers";
import { DurableObject } from "cloudflare:workers";

import { runWithExecutionCtx, setCfEnv } from "~/server/cf-env";
import { withTrace } from "~/server/tracing";

import { authenticateCalendar, calendarDigest } from "./caldav-auth";
import { createCalDavHandler } from "./caldav-http";
import { renderCalDavResource } from "./caldav-ics";
import {
  CalDavError,
  type CalDavBackend,
  type CalDavWrite,
} from "./caldav-types";
import {
  createCalendarFeedToken,
  etagMatches,
  inspectCalendarDocument,
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
        pendingWrites: this.store.pendingCount(),
      },
    };
  }
  async rotate(origin: string) {
    return this.serializePublication(async () => {
      await this.refresh(origin, "rotate");
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
      await this.reconcilePending();
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
    if (this.store.meta().dirtyReason || this.store.pending().length)
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
    const sequence = this.store.meta().dirtySequence;
    return withTrace(
      "calendar.feed.refresh",
      async () => {
        const { resources, snapshot } = await this.withDatabase(async (db) => {
          const [{ loadCalDavProjection }, { buildCalendarSnapshot }] =
            await Promise.all([
              import("~/server/repo/calendar-caldav"),
              import("./snapshot"),
            ]);
          const data = await loadCalDavProjection(db);
          const identityByCode = new Map(
            data.identities.map((identity) => [identity.shortcode, identity]),
          );
          const resources = await Promise.all(
            data.projections.map((projection) =>
              renderCalDavResource(
                projection,
                identityByCode.get(projection.id) ?? {
                  entity: projection.entity,
                  shortcode: projection.id,
                  filename: `${projection.id}.ics`,
                  uid: `${projection.id}@cubby.nickysemenza.com`,
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
  private async reconcilePending() {
    for (const pending of this.store.pending()) {
      try {
        await this.execute(pending.write, pending.origin);
        await this.refresh(pending.origin, "recover-write");
        this.store.removePending(pending.operationId);
      } catch (error) {
        if (error instanceof CalDavError && error.status < 500) {
          this.store.removePending(pending.operationId);
          continue;
        }
        throw error;
      }
    }
  }
  private async write(
    input: Parameters<CalDavBackend["write"]>[0],
    origin: string,
  ) {
    // Calendar clients may regenerate DTSTAMP or discarded notes on retry.
    // Deduplicate the represented mutation rather than incidental wire bytes.
    const fingerprint = await calendarDigest(
      JSON.stringify({
        actorId: input.actorId,
        collection: input.collection,
        filename: input.filename,
        event: input.event,
        ifMatch: input.ifMatch,
        ifNoneMatch: input.ifNoneMatch,
      }),
    );
    const pending = this.store
      .pending()
      .find((entry) => entry.fingerprint === fingerprint);
    const expected =
      pending?.write.expected ??
      this.store.get(input.collection, input.filename);
    if (!pending) this.checkWriteConditions(input, expected);
    const write = pending?.write ?? {
      operationId: crypto.randomUUID(),
      actorId: input.actorId,
      collection: input.collection,
      filename: input.filename,
      expected,
      event: input.event,
    };
    if (!pending) this.store.addPending(write, fingerprint, origin);
    await this.markDirty("caldav-write", origin);
    try {
      await this.execute(write, origin);
      await this.refresh(origin, "caldav-write");
      this.store.removePending(write.operationId);
    } catch (error) {
      if (error instanceof CalDavError && error.status < 500)
        this.store.removePending(write.operationId);
      throw error;
    }
    const resource = this.store.get(input.collection, input.filename);
    const result: WriteResponse = {
      status: input.event === null || write.expected ? 204 : 201,
    };
    if (resource && resource.body === input.body) result.etag = resource.etag;
    return result;
  }
  private checkWriteConditions(
    input: Parameters<CalDavBackend["write"]>[0],
    expected: ReturnType<CalendarSqlStore["get"]>,
  ) {
    if (input.event === null && !expected)
      throw new CalDavError(404, "Calendar event not found");
    if (expected) {
      if (input.ifNoneMatch === "*")
        throw new CalDavError(412, "Calendar event already exists");
      if (!input.ifMatch) throw new CalDavError(428, "If-Match is required");
      if (
        !input.ifMatch
          .split(",")
          .map((value) => value.trim())
          .includes(expected.etag)
      )
        throw new CalDavError(412, "Calendar event has changed");
      if (input.event && input.event.uid !== expected.uid)
        throw new CalDavError(403, "UID cannot change", "no-uid-conflict");
    } else {
      if (input.ifMatch)
        throw new CalDavError(412, "Calendar event no longer exists");
      if (input.ifNoneMatch !== "*")
        throw new CalDavError(428, "If-None-Match: * is required");
      if (input.event && this.store.byUid(input.event.uid))
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
