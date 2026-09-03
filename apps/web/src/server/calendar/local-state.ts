import type { Database } from "~/server/db";

import type {
  CalendarFeedReadResult,
  CalendarFeedState,
  CalendarRefreshResult,
  StoredCalendarDocument,
} from "./contracts";
import {
  createCalendarFeedToken,
  etagMatches,
  inspectCalendarDocument,
} from "./contracts";
import type { IcsFeed } from "./ics";
import { buildCalendarSnapshot, type CalendarSnapshot } from "./snapshot";

const DIRTY_DELAY_MS = 2_000;
type SnapshotBuilder = (
  db: Database,
  options: { origin: string; now: Date; revision: number },
) => Promise<CalendarSnapshot>;

export class InMemoryCalendarFeedState implements CalendarFeedState {
  private token: string | null = null;
  private documents: Record<IcsFeed, StoredCalendarDocument> | null = null;
  private revision = 0;
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private dirtyReason: string | null = null;
  private dirtySequence = 0;
  private alarmAt: string | null = null;

  constructor(
    private readonly origin: string,
    private db: Database | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly tokenFactory: () => string = createCalendarFeedToken,
    private readonly snapshotBuilder: SnapshotBuilder = buildCalendarSnapshot,
  ) {}

  setDatabase(db: Database): void {
    this.db = db;
  }

  async getToken(): Promise<string | null> {
    return this.token;
  }

  async inspect() {
    const generatedAt =
      this.documents?.all.generatedAt ??
      this.documents?.meals.generatedAt ??
      this.documents?.tasks.generatedAt ??
      null;
    return {
      schemaVersion: 1 as const,
      inspectedAt: this.now().toISOString(),
      runtime: "memory" as const,
      origin: this.origin,
      object: { id: null, jurisdiction: null },
      tokenConfigured: this.token !== null,
      snapshot:
        this.revision > 0
          ? {
              revision: this.revision,
              generatedAt,
            }
          : null,
      dirty:
        this.dirtyReason === null
          ? null
          : { reason: this.dirtyReason, sequence: this.dirtySequence },
      alarmAt: this.alarmAt,
      feeds: {
        meals: inspectCalendarDocument(this.documents?.meals),
        tasks: inspectCalendarDocument(this.documents?.tasks),
        all: inspectCalendarDocument(this.documents?.all),
      },
    };
  }

  async rotate(): Promise<string> {
    const db = this.requireDatabase();
    const revision = this.revision + 1;
    const snapshot = await this.snapshotBuilder(db, {
      origin: this.origin,
      now: this.now(),
      revision,
    });
    const token = this.tokenFactory();
    this.documents = snapshot.documents;
    this.revision = revision;
    this.token = token;
    return token;
  }

  async read(
    token: string,
    feed: IcsFeed,
    ifNoneMatch: string | null,
  ): Promise<CalendarFeedReadResult> {
    if (token !== this.token || !this.documents) return { result: "not_found" };
    const document = this.documents[feed];
    if (etagMatches(ifNoneMatch, document.etag)) {
      return {
        result: "not_modified",
        etag: document.etag,
        generatedAt: document.generatedAt,
        revision: document.revision,
        itemCount: document.itemCount,
      };
    }
    return { result: "served", ...document };
  }

  async markDirty(reason: string): Promise<void> {
    if (!this.token) return;
    this.dirtyReason = reason;
    this.dirtySequence += 1;
    if (this.dirtyTimer) return;
    this.alarmAt = new Date(
      this.now().getTime() + DIRTY_DELAY_MS,
    ).toISOString();
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      this.alarmAt = null;
      const refreshReason = this.dirtyReason ?? "dirty";
      this.dirtyReason = null;
      void this.refreshNow(refreshReason).catch((error) => {
        console.error("[calendar-feed] local refresh failed", error);
      });
    }, DIRTY_DELAY_MS);
  }

  async refreshNow(_reason: string): Promise<CalendarRefreshResult | null> {
    if (!this.token) return null;
    const db = this.requireDatabase();
    const revision = this.revision + 1;
    const snapshot = await this.snapshotBuilder(db, {
      origin: this.origin,
      now: this.now(),
      revision,
    });
    this.documents = snapshot.documents;
    this.revision = revision;
    return {
      generatedAt: snapshot.generatedAt,
      revision,
      counts: snapshot.counts,
    };
  }

  private requireDatabase(): Database {
    if (!this.db) {
      throw new Error(
        "Calendar feed state has no database for snapshot refresh",
      );
    }
    return this.db;
  }
}

const states = new Map<string, InMemoryCalendarFeedState>();

export function getInMemoryCalendarFeedState(
  origin: string,
  db?: Database,
): InMemoryCalendarFeedState {
  const hostname = new URL(origin).hostname;
  let state = states.get(hostname);
  if (!state) {
    state = new InMemoryCalendarFeedState(origin, db);
    states.set(hostname, state);
  } else if (db) {
    state.setDatabase(db);
  }
  return state;
}
