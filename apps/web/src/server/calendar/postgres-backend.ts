/**
 * The calendar object's PostgreSQL side: the projection it publishes and the
 * CalDAV writes it executes. `CalendarFeedObject` loads this on its first
 * refresh or write; CalDAV and feed reads answer from its SQLite without it.
 */
export { db, withRequestDbClient } from "~/server/db";
export {
  executeCalDavWrite,
  loadCalDavProjection,
} from "~/server/repo/calendar-caldav";

export { buildCalendarSnapshot } from "./snapshot";
