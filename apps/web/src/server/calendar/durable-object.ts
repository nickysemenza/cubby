import { DurableObject } from "cloudflare:workers";

import { withTrace } from "~/server/tracing";

import type {
  CalendarFeedReadResult,
  CalendarFeedDurableObjectRpc,
  CalendarRefreshResult,
  StoredCalendarDocument,
} from "./contracts";
import {
  createCalendarFeedToken,
  etagMatches,
  inspectCalendarDocument,
} from "./contracts";
import type { IcsFeed } from "./ics";

const META_KEY = "calendar:meta";
const DIRTY_KEY = "calendar:dirty";
const DIRTY_DELAY_MS = 2_000;
const documentKey = (feed: IcsFeed) => `calendar:feed:${feed}`;

interface CalendarMeta {
  token: string;
  revision: number;
}

interface DirtyState {
  origin: string;
  reason: string;
  sequence: number;
}

const countsFrom = (
  documents: Record<IcsFeed, StoredCalendarDocument>,
): CalendarRefreshResult["counts"] => ({
  meals: documents.meals.itemCount,
  tasks: documents.tasks.itemCount,
  all: documents.all.itemCount,
});

export class CalendarFeedDurableObject
  extends DurableObject<Env>
  implements CalendarFeedDurableObjectRpc
{
  private publicationTail: Promise<void> = Promise.resolve();

  async getToken(): Promise<string | null> {
    return (await this.ctx.storage.get<CalendarMeta>(META_KEY))?.token ?? null;
  }

  async inspect(origin: string) {
    const [meta, dirty, alarm, meals, tasks, all] = await Promise.all([
      this.ctx.storage.get<CalendarMeta>(META_KEY),
      this.ctx.storage.get<DirtyState>(DIRTY_KEY),
      this.ctx.storage.getAlarm(),
      this.ctx.storage.get<StoredCalendarDocument>(documentKey("meals")),
      this.ctx.storage.get<StoredCalendarDocument>(documentKey("tasks")),
      this.ctx.storage.get<StoredCalendarDocument>(documentKey("all")),
    ]);
    const generatedAt =
      all?.generatedAt ?? meals?.generatedAt ?? tasks?.generatedAt ?? null;
    return {
      schemaVersion: 1 as const,
      inspectedAt: new Date().toISOString(),
      runtime: "durable-object" as const,
      origin,
      object: {
        id: this.ctx.id.toString(),
        jurisdiction: this.ctx.id.jurisdiction ?? null,
      },
      tokenConfigured: Boolean(meta?.token),
      snapshot: meta
        ? {
            revision: meta.revision,
            generatedAt,
          }
        : null,
      dirty: dirty
        ? {
            reason: dirty.reason,
            sequence: dirty.sequence,
          }
        : null,
      alarmAt: alarm === null ? null : new Date(alarm).toISOString(),
      feeds: {
        meals: inspectCalendarDocument(meals),
        tasks: inspectCalendarDocument(tasks),
        all: inspectCalendarDocument(all),
      },
    };
  }

  async rotate(origin: string): Promise<string> {
    return await this.serializePublication(async () => {
      const current = await this.ctx.storage.get<CalendarMeta>(META_KEY);
      const revision = (current?.revision ?? 0) + 1;
      const snapshot = await this.buildSnapshot(origin, revision, "rotate");
      const token = createCalendarFeedToken();
      await this.ctx.storage.put({
        [META_KEY]: { token, revision } satisfies CalendarMeta,
        [documentKey("meals")]: snapshot.documents.meals,
        [documentKey("tasks")]: snapshot.documents.tasks,
        [documentKey("all")]: snapshot.documents.all,
      });
      return token;
    });
  }

  async read(
    token: string,
    feed: IcsFeed,
    ifNoneMatch: string | null,
  ): Promise<CalendarFeedReadResult> {
    return await withTrace(
      "calendar.feed.read",
      async (span) => {
        const meta = await this.ctx.storage.get<CalendarMeta>(META_KEY);
        if (!meta || token !== meta.token) {
          span.setAttribute("cubby.calendar.result", "not_found");
          return { result: "not_found" };
        }
        const document = await this.ctx.storage.get<StoredCalendarDocument>(
          documentKey(feed),
        );
        if (!document) {
          span.setAttribute("cubby.calendar.result", "not_found");
          return { result: "not_found" };
        }
        const ageSeconds = Math.max(
          0,
          Math.round((Date.now() - Date.parse(document.generatedAt)) / 1_000),
        );
        span.setAttributes({
          "cubby.calendar.feed": feed,
          "cubby.calendar.snapshot_age_seconds": ageSeconds,
          "cubby.calendar.snapshot_revision": document.revision,
          "cubby.calendar.item_count": document.itemCount,
        });
        if (etagMatches(ifNoneMatch, document.etag)) {
          span.setAttribute("cubby.calendar.result", "not_modified");
          return {
            result: "not_modified",
            etag: document.etag,
            generatedAt: document.generatedAt,
            revision: document.revision,
            itemCount: document.itemCount,
          };
        }
        span.setAttribute("cubby.calendar.result", "served");
        return { result: "served", ...document };
      },
      { "cubby.calendar.feed": feed },
    );
  }

  async markDirty(reason: string, origin: string): Promise<void> {
    if (!(await this.ctx.storage.get<CalendarMeta>(META_KEY))) return;
    const current = await this.ctx.storage.get<DirtyState>(DIRTY_KEY);
    await this.ctx.storage.put(DIRTY_KEY, {
      reason,
      origin,
      sequence: (current?.sequence ?? 0) + 1,
    } satisfies DirtyState);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DIRTY_DELAY_MS);
    }
  }

  async refreshNow(
    reason: string,
    origin: string,
  ): Promise<CalendarRefreshResult | null> {
    return await this.serializePublication(async () => {
      const meta = await this.ctx.storage.get<CalendarMeta>(META_KEY);
      if (!meta) return null;
      const revision = meta.revision + 1;
      const snapshot = await this.buildSnapshot(origin, revision, reason);
      await this.ctx.storage.put({
        [META_KEY]: { ...meta, revision } satisfies CalendarMeta,
        [documentKey("meals")]: snapshot.documents.meals,
        [documentKey("tasks")]: snapshot.documents.tasks,
        [documentKey("all")]: snapshot.documents.all,
      });
      return {
        generatedAt: snapshot.generatedAt,
        revision,
        counts: countsFrom(snapshot.documents),
      };
    });
  }

  async alarm(): Promise<void> {
    const dirty = await this.ctx.storage.get<DirtyState>(DIRTY_KEY);
    if (!dirty) return;
    await this.refreshNow(dirty.reason, dirty.origin);
    const afterRefresh = await this.ctx.storage.get<DirtyState>(DIRTY_KEY);
    if (afterRefresh?.sequence === dirty.sequence) {
      await this.ctx.storage.delete(DIRTY_KEY);
    }
  }

  private async buildSnapshot(
    origin: string,
    revision: number,
    reason: string,
  ) {
    return await withTrace(
      "calendar.feed.refresh",
      async (span) => {
        try {
          const [{ db, withRequestDbClient }, { buildCalendarSnapshot }] =
            await Promise.all([import("~/server/db"), import("./snapshot")]);
          const snapshot = await withRequestDbClient(
            this.env.HYPERDRIVE.connectionString,
            async () => {
              return await buildCalendarSnapshot(db, {
                origin,
                now: new Date(),
                revision,
              });
            },
          );
          span.setAttributes({
            "cubby.calendar.snapshot_revision": revision,
            "cubby.calendar.meals_count": snapshot.counts.meals,
            "cubby.calendar.tasks_count": snapshot.counts.tasks,
            "cubby.calendar.all_count": snapshot.counts.all,
          });
          return snapshot;
        } catch (error) {
          span.setAttribute("cubby.calendar.refresh_failure", true);
          throw error;
        }
      },
      { "cubby.calendar.refresh_reason": reason },
    );
  }

  private async serializePublication<T>(run: () => Promise<T>): Promise<T> {
    const result = this.publicationTail.then(run, run);
    this.publicationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}
