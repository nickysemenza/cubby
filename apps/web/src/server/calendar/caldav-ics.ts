import {
  MEAL_SLOT_DURATION_MINUTES,
  MEAL_TYPE_LABELS,
  MEAL_TYPE_START_MINUTES,
  mealTypeValues,
  type MealType,
} from "@cubby/schemas/meal-classification";
import { tradeSchema } from "@cubby/schemas/task-fields";
import { TZDate } from "@date-fns/tz";
import ICAL from "ical.js";
import { z } from "zod";

import {
  HOUSEHOLD_TIMEZONE,
  householdDateTime,
  householdLocalDate,
} from "~/lib/household-date";

import type {
  CalDavCollection,
  CalDavEventInput,
  CalDavResource,
  CalendarIdentity,
  CalendarProjection,
} from "./caldav-types";
import { serializeCalendarComponent } from "./ics";

function invalid(message: string): never {
  throw new Error(`Invalid CalDAV event: ${message}`);
}
function shiftDate(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
function validDate(date: string): boolean {
  const value = new Date(`${date}T00:00:00Z`);
  return (
    !Number.isNaN(value.getTime()) && value.toISOString().slice(0, 10) === date
  );
}
function plainDate(time: ICAL.Time): string {
  return time.toString().slice(0, 10);
}
function validateRawDates(body: string): void {
  for (const line of body.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    if (!/^(DTSTART|DTEND)[;:]/i.test(line)) continue;
    const value = line.slice(line.indexOf(":") + 1);
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
      value,
    );
    if (!match || !validDate(`${match[1]}-${match[2]}-${match[3]}`))
      invalid("invalid date");
    if (match[4] && (+match[4] > 23 || +match[5]! > 59 || +match[6]! > 59))
      invalid("invalid time");
  }
}
function parseEvent(body: string): ICAL.Component {
  if (body.length > 1_000_000) invalid("request body is too large");
  validateRawDates(body);
  let calendar: ICAL.Component;
  try {
    calendar = new ICAL.Component(ICAL.parse(body));
  } catch {
    // SILENT: invalid() has return type `never` and always throws; it replaces
    // ICAL.parse's raw parser exception with a clearer client-facing message.
    invalid("malformed iCalendar");
  }
  if (calendar.name !== "vcalendar") invalid("VCALENDAR is required");
  if (calendar.hasProperty("method"))
    invalid("METHOD scheduling is unsupported");
  const components = calendar.getAllSubcomponents();
  if (
    components.length > 33 ||
    components.some(
      (node) => node.name !== "vevent" && node.name !== "vtimezone",
    )
  )
    invalid("unsupported calendar component");
  const events = calendar.getAllSubcomponents("vevent");
  if (events.length !== 1) invalid("exactly one VEVENT is required");
  const event = events[0]!;
  if (event.getAllSubcomponents().some((node) => node.name !== "valarm"))
    invalid("unsupported event component");
  return event;
}
function validateProperties(event: ICAL.Component): void {
  for (const property of [
    "rrule",
    "exrule",
    "rdate",
    "exdate",
    "attendee",
    "organizer",
    "recurrence-id",
    "request-status",
  ]) {
    if (event.hasProperty(property))
      invalid(`${property.toUpperCase()} is unsupported`);
  }
  for (const name of ["uid", "summary", "dtstart"]) {
    if (event.getAllProperties(name).length !== 1)
      invalid(`exactly one ${name.toUpperCase()} is required`);
  }
  for (const name of ["dtend", "duration"]) {
    if (event.getAllProperties(name).length > 1)
      invalid(`at most one ${name.toUpperCase()} is allowed`);
  }
  if (event.hasProperty("dtend") && event.hasProperty("duration"))
    invalid("DTEND and DURATION cannot both be present");
}
function timeProperty(event: ICAL.Component, name: string): ICAL.Time | null {
  const value = event.getFirstPropertyValue(name);
  if (value === null) return null;
  if (!(value instanceof ICAL.Time)) invalid(`invalid ${name.toUpperCase()}`);
  return value;
}
function durationProperty(event: ICAL.Component): ICAL.Duration | null {
  const value = event.getFirstPropertyValue("duration");
  if (value === null) return null;
  if (!(value instanceof ICAL.Duration) || value.toSeconds() <= 0)
    invalid("duration must be positive");
  return value;
}
function instant(
  time: ICAL.Time,
  event: ICAL.Component,
  property: string,
): Date {
  const parsedZone = z
    .string()
    .optional()
    .safeParse(event.getFirstProperty(property)?.getParameter("tzid"));
  if (!parsedZone.success) invalid("invalid timezone parameter");
  const timezone = parsedZone.data;
  if (time.zone === ICAL.Timezone.utcTimezone && !timezone)
    return time.toJSDate();
  const embedded =
    event.parent
      ?.getAllSubcomponents("vtimezone")
      .filter((zone) => zone.getFirstPropertyValue("tzid") === timezone) ?? [];
  if (embedded.length > 1) invalid("ambiguous embedded timezone");
  if (embedded[0] && timezone) {
    const resolved = time.clone();
    resolved.zone = new ICAL.Timezone({
      component: embedded[0],
      tzid: timezone,
    });
    return resolved.toJSDate();
  }
  const zone = timezone ?? HOUSEHOLD_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
  } catch {
    // SILENT: invalid() has return type `never` and always throws; it replaces
    // the raw Intl exception with a clearer client-facing message.
    invalid(`unresolvable timezone ${zone}`);
  }
  const resolved = new TZDate(
    time.year,
    time.month - 1,
    time.day,
    time.hour,
    time.minute,
    time.second,
    zone,
  );
  if (!Number.isFinite(resolved.getTime())) invalid("unresolvable timezone");
  return new Date(resolved.getTime());
}
function endInstant(start: ICAL.Time, event: ICAL.Component): Date {
  const end = timeProperty(event, "dtend");
  if (end) {
    if (end.isDate) invalid("DTSTART and DTEND must have matching value types");
    return instant(end, event, "dtend");
  }
  const duration = durationProperty(event);
  if (!duration) invalid("DTEND or DURATION is required");
  // RFC durations apply nominal days first, then elapsed hours/minutes/seconds.
  const shifted = start.clone();
  shifted.adjust(duration.weeks * 7 + duration.days, 0, 0, 0);
  const result = instant(shifted, event, "dtstart");
  return new Date(
    result.getTime() +
      (duration.hours * 3600 + duration.minutes * 60 + duration.seconds) * 1000,
  );
}
function allDayEnd(start: ICAL.Time, event: ICAL.Component): string {
  const end = timeProperty(event, "dtend");
  if (end) {
    if (!end.isDate)
      invalid("DTSTART and DTEND must have matching value types");
    return plainDate(end);
  }
  const duration = durationProperty(event);
  if (!duration) return shiftDate(plainDate(start), 1);
  if (duration.hours || duration.minutes || duration.seconds)
    invalid("all-day duration requires whole days");
  return shiftDate(plainDate(start), duration.weeks * 7 + duration.days);
}
function nearestSlot(start: Date): MealType {
  const local = new TZDate(start.getTime(), HOUSEHOLD_TIMEZONE);
  const minutes =
    local.getHours() * 60 + local.getMinutes() + local.getSeconds() / 60;
  const slots: readonly MealType[] = mealTypeValues;
  return slots.reduce((best, slot) =>
    Math.abs(MEAL_TYPE_START_MINUTES[slot] - minutes) <
    Math.abs(MEAL_TYPE_START_MINUTES[best] - minutes)
      ? slot
      : best,
  );
}
/** Parses only the event fields represented by canonical Cubby mutations. */
export function parseCalDavEvent(
  body: string,
  collection: CalDavCollection,
): CalDavEventInput {
  const event = parseEvent(body);
  validateProperties(event);
  const identity = z
    .object({
      uid: z.string().min(1).max(1024),
      summary: z.string().trim().min(1),
    })
    .safeParse({
      uid: event.getFirstPropertyValue("uid"),
      summary: event.getFirstPropertyValue("summary"),
    });
  if (!identity.success) invalid("UID and SUMMARY are required");
  const { uid, summary } = identity.data;
  const rawTrade = event.getFirstPropertyValue("x-cubby-trade");
  const classification =
    rawTrade == null ? undefined : tradeSchema.safeParse(rawTrade);
  if (classification && !classification.success)
    invalid("X-CUBBY-TRADE must be a valid Cubby trade");
  const trade = classification?.success ? classification.data : undefined;
  const start = timeProperty(event, "dtstart");
  if (!start) invalid("DTSTART is required");
  if (start.isDate) {
    const startDate = plainDate(start);
    const endDateExclusive = allDayEnd(start, event);
    if (endDateExclusive <= startDate) invalid("duration must be positive");
    if (collection === "meals" && endDateExclusive !== shiftDate(startDate, 1))
      invalid("an all-day meal must be one day");
    return {
      uid,
      trade,
      summary: summary.trim(),
      startDate,
      endDateExclusive,
      mealType: null,
    };
  }
  const begins = instant(start, event, "dtstart");
  const ends = endInstant(start, event);
  if (!(ends.getTime() > begins.getTime()))
    invalid("duration must be positive");
  const startDate = householdLocalDate(begins);
  if (collection === "meals" && householdLocalDate(ends) !== startDate)
    invalid("a timed meal may not cross midnight");
  const endDateExclusive = shiftDate(
    householdLocalDate(new Date(ends.getTime() - 1)),
    1,
  );
  return {
    uid,
    trade,
    summary: summary.trim(),
    startDate,
    endDateExclusive,
    mealType: collection === "meals" ? nearestSlot(begins) : null,
  };
}
function collectionFor(projection: CalendarProjection): CalDavCollection {
  return projection.entity === "meal"
    ? "meals"
    : projection.status === "done"
      ? "completed-tasks"
      : "tasks";
}
interface EventBounds {
  start: Date;
  end: Date;
}
function setDates(
  event: ICAL.Component,
  projection: CalendarProjection,
): EventBounds {
  if (projection.entity === "meal" && projection.mealType) {
    const start = householdDateTime(
      projection.date,
      MEAL_TYPE_START_MINUTES[projection.mealType],
    );
    const end = new Date(start.getTime() + MEAL_SLOT_DURATION_MINUTES * 60_000);
    event.addPropertyWithValue("dtstart", ICAL.Time.fromJSDate(start, true));
    event.addPropertyWithValue("dtend", ICAL.Time.fromJSDate(end, true));
    return { start, end };
  }
  const begin =
    projection.entity === "meal"
      ? projection.date
      : (projection.dueDate ?? projection.dueEndDate);
  const last =
    projection.entity === "meal"
      ? projection.date
      : (projection.dueEndDate ?? projection.dueDate);
  if (!begin || !last || last < begin)
    throw new Error("Calendar projection lacks valid event dates");
  const exclusive = shiftDate(last, 1);
  event.addPropertyWithValue("dtstart", ICAL.Time.fromDateString(begin));
  event.addPropertyWithValue("dtend", ICAL.Time.fromDateString(exclusive));
  return { start: householdDateTime(begin), end: householdDateTime(exclusive) };
}
/** Deterministic bytes: unrelated entity changes must not churn strong ETags. */
export async function renderCalDavResource(
  projection: CalendarProjection,
  identity: CalendarIdentity,
  origin: string,
): Promise<CalDavResource> {
  const calendar = new ICAL.Component("vcalendar");
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("prodid", "-//Cubby//CalDAV//EN");
  calendar.addPropertyWithValue("calscale", "GREGORIAN");
  const event = new ICAL.Component("vevent");
  const uid = identity.uid;
  event.addPropertyWithValue("uid", uid);
  // Stable baseline; resource ETags, rather than unrelated updatedAt, drive DAV changes.
  event.addPropertyWithValue(
    "dtstamp",
    ICAL.Time.fromDateTimeString("1970-01-01T00:00:00Z"),
  );
  const { start, end } = setDates(event, projection);
  const generatedName =
    projection.entity === "meal" && projection.mealType
      ? MEAL_TYPE_LABELS[projection.mealType]
      : "Meal";
  event.addPropertyWithValue("summary", projection.name ?? generatedName);
  event.addPropertyWithValue(
    "url",
    `${origin}/${projection.entity === "meal" ? "meals" : "tasks"}/${identity.shortcode}`,
  );
  event.addPropertyWithValue("transp", "TRANSPARENT");
  calendar.addSubcomponent(event);
  const body = serializeCalendarComponent(calendar);
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const etag = `"${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
  return {
    collection: collectionFor(projection),
    filename: identity.filename,
    uid,
    body,
    etag,
    start: start.toISOString(),
    end: end.toISOString(),
    projection,
  };
}
