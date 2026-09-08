import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { and, count, eq, gt, lt, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import type {
  CalDavCollection,
  CalDavResource,
  CalDavWrite,
} from "./caldav-types";
import { calendarProjectionSchema, calDavWriteSchema } from "./caldav-types";
import type { StoredCalendarDocument } from "./contracts";
import type { IcsFeed } from "./ics";
import migration from "./migrations/0000_bright_tyger_tiger.sql?raw";
import journal from "./migrations/meta/_journal.json";
import {
  calendarMeta,
  calendarResources,
  calendarDocuments,
  calendarCredentials,
  calendarPending,
} from "./sql-schema";

export class CalendarSqlStore {
  private readonly db;
  constructor(storage: DurableObjectStorage) {
    this.db = drizzle(storage);
  }

  async migrate() {
    await migrate(this.db, { journal, migrations: { m0000: migration } });
    this.db.insert(calendarMeta).values({ id: 1 }).onConflictDoNothing().run();
  }

  meta() {
    const value = this.db
      .select()
      .from(calendarMeta)
      .where(eq(calendarMeta.id, 1))
      .get();
    if (!value) throw new Error("Calendar storage has not been initialized");
    return value;
  }

  setToken(token: string) {
    this.db
      .update(calendarMeta)
      .set({ token })
      .where(eq(calendarMeta.id, 1))
      .run();
  }

  dirty(reason: string, origin: string) {
    const sequence = this.meta().dirtySequence + 1;
    this.db
      .update(calendarMeta)
      .set({ dirtyReason: reason, dirtySequence: sequence, origin })
      .where(eq(calendarMeta.id, 1))
      .run();
    return sequence;
  }

  clearDirty(sequence: number) {
    this.db
      .update(calendarMeta)
      .set({ dirtyReason: null })
      .where(
        and(eq(calendarMeta.id, 1), eq(calendarMeta.dirtySequence, sequence)),
      )
      .run();
  }

  publish(
    resources: CalDavResource[],
    documents: Record<IcsFeed, StoredCalendarDocument>,
    origin: string,
  ) {
    const generation = this.meta().generation + 1;
    this.db.transaction((tx) => {
      for (const resource of resources) {
        tx.insert(calendarResources)
          .values({
            generation,
            collection: resource.collection,
            filename: resource.filename,
            uid: resource.uid,
            shortcode: resource.projection.id,
            body: resource.body,
            etag: resource.etag,
            start: resource.start,
            end: resource.end,
            projection: JSON.stringify(resource.projection),
          })
          .run();
      }
      for (const [feed, document] of Object.entries(documents)) {
        const value = { feed, ...document, revision: generation };
        tx.insert(calendarDocuments)
          .values(value)
          .onConflictDoUpdate({ target: calendarDocuments.feed, set: value })
          .run();
      }
      tx.update(calendarMeta)
        .set({ generation, generatedAt: documents.all.generatedAt, origin })
        .where(eq(calendarMeta.id, 1))
        .run();
      tx.delete(calendarResources)
        .where(ne(calendarResources.generation, generation))
        .run();
    });
    return generation;
  }

  list(
    collection: CalDavCollection,
    range?: { start?: string; end?: string },
  ): CalDavResource[] {
    return this.db
      .select()
      .from(calendarResources)
      .where(
        and(
          eq(calendarResources.generation, this.meta().generation),
          eq(calendarResources.collection, collection),
          range?.start ? gt(calendarResources.end, range.start) : undefined,
          range?.end ? lt(calendarResources.start, range.end) : undefined,
        ),
      )
      .orderBy(calendarResources.filename)
      .all()
      .map(decodeResource);
  }

  get(collection: CalDavCollection, filename: string): CalDavResource | null {
    const row = this.db
      .select()
      .from(calendarResources)
      .where(
        and(
          eq(calendarResources.generation, this.meta().generation),
          eq(calendarResources.collection, collection),
          eq(calendarResources.filename, filename),
        ),
      )
      .get();
    return row ? decodeResource(row) : null;
  }

  byUid(uid: string) {
    return this.db
      .select()
      .from(calendarResources)
      .where(
        and(
          eq(calendarResources.generation, this.meta().generation),
          eq(calendarResources.uid, uid),
        ),
      )
      .get();
  }

  counts() {
    const rows = this.db
      .select({ collection: calendarResources.collection, total: count() })
      .from(calendarResources)
      .where(eq(calendarResources.generation, this.meta().generation))
      .groupBy(calendarResources.collection)
      .all();
    const counts = { tasks: 0, completedTasks: 0, meals: 0 };
    for (const row of rows) {
      if (row.collection === "completed-tasks")
        counts.completedTasks = row.total;
      else counts[row.collection] = row.total;
    }
    return counts;
  }

  pendingCount() {
    return (
      this.db.select({ total: count() }).from(calendarPending).get()?.total ?? 0
    );
  }

  document(feed: IcsFeed): StoredCalendarDocument | null {
    return (
      this.db
        .select()
        .from(calendarDocuments)
        .where(eq(calendarDocuments.feed, feed))
        .get() ?? null
    );
  }

  credential(owner: string) {
    return this.db
      .select()
      .from(calendarCredentials)
      .where(eq(calendarCredentials.owner, owner))
      .get();
  }
  credentialByUsername(username: string) {
    return this.db
      .select()
      .from(calendarCredentials)
      .where(eq(calendarCredentials.username, username))
      .get();
  }
  setCredential(value: typeof calendarCredentials.$inferInsert) {
    this.db
      .insert(calendarCredentials)
      .values(value)
      .onConflictDoUpdate({ target: calendarCredentials.owner, set: value })
      .run();
  }
  revokeCredential(owner: string) {
    this.db
      .delete(calendarCredentials)
      .where(eq(calendarCredentials.owner, owner))
      .run();
  }

  pending() {
    return this.db
      .select()
      .from(calendarPending)
      .all()
      .map((row) => ({
        ...row,
        write: calDavWriteSchema.parse(JSON.parse(row.payload)),
      }));
  }
  addPending(write: CalDavWrite, fingerprint: string, origin: string) {
    this.db
      .insert(calendarPending)
      .values({
        operationId: write.operationId,
        fingerprint,
        origin,
        payload: JSON.stringify(write),
      })
      .run();
  }
  removePending(operationId: string) {
    this.db
      .delete(calendarPending)
      .where(eq(calendarPending.operationId, operationId))
      .run();
  }
}

function decodeResource(
  row: typeof calendarResources.$inferSelect,
): CalDavResource {
  return {
    ...row,
    projection: calendarProjectionSchema.parse(JSON.parse(row.projection)),
  };
}
