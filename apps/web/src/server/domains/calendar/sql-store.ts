import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { and, count, eq, gt, lt, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import type {
  CalDavCollection,
  CalDavResource,
  CalendarIdentity,
} from "./caldav-types";
import { calendarProjectionSchema } from "./caldav-types";
import type { StoredCalendarDocument } from "./contracts";
import type { IcsFeed } from "./ics";
import migration from "./migrations/0000_bright_tyger_tiger.sql?raw";
import resetMigration from "./migrations/0001_watery_tomas.sql?raw";
import journal from "./migrations/meta/_journal.json";
import {
  calendarMeta,
  calendarResources,
  calendarDocuments,
  calendarCredentials,
  calendarIdentities,
  calendarUncertainWrites,
} from "./sql-schema";

export class CalendarSqlStore {
  private readonly db;
  constructor(storage: DurableObjectStorage) {
    this.db = drizzle(storage);
  }

  async migrate() {
    await migrate(this.db, {
      journal,
      migrations: { m0000: migration, m0001: resetMigration },
    });
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
        tx.insert(calendarIdentities)
          .values({
            entity: resource.projection.entity,
            shortcode: resource.projection.id,
            uid: resource.uid,
            filename: resource.filename,
          })
          .onConflictDoNothing({ target: calendarIdentities.shortcode })
          .run();
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
        .set({
          generation,
          generatedAt: documents.all.generatedAt,
          origin,
          refreshFailedAt: null,
        })
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
      .from(calendarIdentities)
      .where(eq(calendarIdentities.uid, uid))
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

  identities() {
    return this.db.select().from(calendarIdentities).all();
  }
  rememberIdentity(identity: CalendarIdentity) {
    this.db
      .insert(calendarIdentities)
      .values(identity)
      .onConflictDoNothing({ target: calendarIdentities.shortcode })
      .run();
  }
  identityAt(entity: "task" | "meal", filename: string) {
    return this.db
      .select()
      .from(calendarIdentities)
      .where(
        and(
          eq(calendarIdentities.entity, entity),
          eq(calendarIdentities.filename, filename),
        ),
      )
      .get();
  }
  uncertainWrites() {
    return this.db.select().from(calendarUncertainWrites).all();
  }
  startWrite(value: typeof calendarUncertainWrites.$inferInsert) {
    this.db.insert(calendarUncertainWrites).values(value).run();
  }
  clearUncertainWrite(collection: CalDavCollection, filename: string) {
    this.db
      .delete(calendarUncertainWrites)
      .where(
        and(
          eq(
            calendarUncertainWrites.entity,
            collection === "meals" ? "meal" : "task",
          ),
          eq(calendarUncertainWrites.filename, filename),
        ),
      )
      .run();
  }
  refreshFailed() {
    this.db
      .update(calendarMeta)
      .set({ refreshFailedAt: new Date().toISOString() })
      .where(eq(calendarMeta.id, 1))
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
