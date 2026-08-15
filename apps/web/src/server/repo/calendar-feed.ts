import type { UserId } from "@cubby/schemas/identifiers";
import { unsafeUserId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import type { Database } from "~/server/db";
import { user } from "~/server/db/schema";
import { getDb, updateAndReturn } from "./database-helpers";

/**
 * Bytes of entropy in a feed token. 32 bytes = 256 bits, base64url-encoded to
 * 43 characters — far past guessing range for a URL that is never rate-limited
 * (Calendar.app polls it unattended).
 */
const TOKEN_BYTES = 32;

function base64Url(bytes: Uint8Array): string {
  // btoa over a binary string: Workers has no Buffer, and String.fromCharCode
  // on a 32-byte array is well under any argument-count limit.
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint a new calendar feed token for `userId`, replacing any existing one.
 *
 * This is both "create my feed" and "rotate my feed" — there is deliberately no
 * separate mint path, because overwriting is the correct behavior for each. The
 * old token stops resolving the moment this commits.
 *
 * Returns the new token: callers must render *this* value rather than re-reading
 * `session.user`, which is served from a signed cookie cache for up to
 * `session.cookieCache.maxAge` (5 min) and will still carry the dead token.
 */
export async function rotateCalendarFeedToken(
  db: Database,
  userId: UserId,
): Promise<string> {
  const token = base64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  await updateAndReturn(
    db,
    user,
    { calendarFeedToken: token },
    eq(user.id, userId),
  );
  return token;
}

/**
 * Resolve a feed token to its owner, or null if it matches no one.
 *
 * The caller must treat null as a 404 rather than a 401 — a 401 would confirm
 * that the URL shape is real to anyone probing it.
 */
export async function findUserByCalendarFeedToken(
  db: Database,
  token: string,
): Promise<UserId | null> {
  if (!token) return null;
  const row = await getDb(db).query.user.findFirst({
    columns: { id: true },
    where: eq(user.calendarFeedToken, token),
  });
  return row ? unsafeUserId(row.id) : null;
}
