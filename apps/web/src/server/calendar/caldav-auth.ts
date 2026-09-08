import { timingSafeEqual } from "node:crypto";

import { userId } from "@cubby/schemas/identifiers";
import { parse } from "basic-auth";

import type { CalendarSqlStore } from "./sql-store";

export async function calendarDigest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function authenticateCalendar(
  store: CalendarSqlStore,
  authorization: string | null,
) {
  const credentials = parse(authorization ?? "");
  if (!credentials) return null;
  const record = store.credentialByUsername(credentials.name);
  const actual = await calendarDigest(credentials.pass);
  const expected = record?.hash ?? "0".repeat(64);
  const valid = timingSafeEqual(
    new TextEncoder().encode(actual),
    new TextEncoder().encode(expected),
  );
  return valid && record ? userId.parse(record.owner) : null;
}
