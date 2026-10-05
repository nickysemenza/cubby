import { timingSafeEqual } from "node:crypto";

import { userId } from "@cubby/schemas/identifiers";
import { parse } from "basic-auth";

import { sha256Hex } from "~/server/semantic/hash";

import type { CalendarSqlStore } from "./sql-store";

export async function authenticateCalendar(
  store: CalendarSqlStore,
  authorization: string | null,
) {
  const credentials = parse(authorization ?? "");
  if (!credentials) return null;
  const record = store.credentialByUsername(credentials.name);
  const actual = await sha256Hex(credentials.pass);
  const expected = record?.hash ?? "0".repeat(64);
  const valid = timingSafeEqual(
    new TextEncoder().encode(actual),
    new TextEncoder().encode(expected),
  );
  return valid && record ? userId.parse(record.owner) : null;
}
