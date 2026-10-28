import { AsyncLocalStorage } from "node:async_hooks";

import type { UserId } from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";
import { createCookieGetter, parseCookies } from "better-auth/cookies";
import { signJWT, verifyJWT } from "better-auth/crypto";
import { z } from "zod";

import { MEMBER_WRITE_COOKIE } from "~/lib/read-consistency";
import type { MemberReadMarker } from "~/server/db/read-consistency";
import {
  getAuthConfiguration,
  getAuthSecret,
} from "~/server/http/auth-configuration";

import { HYPERDRIVE_CACHE_POLICY } from "./hyperdrive-cache-policy";

export type FreshnessMember = { userId: UserId; sessionId: string | null };
const markerSchema = z.object({
  purpose: z.literal("cubby-last-write"),
  userId: z.string(),
  sessionId: z.string().nullable(),
  lastWriteAt: z.number().int().nonnegative(),
});
const log = createLogger("member-freshness");
const scope = new AsyncLocalStorage<{
  member?: FreshnessMember;
  lastWriteAt?: number;
}>();

const markerCookie = () => {
  const configuration = getAuthConfiguration();
  return createCookieGetter({
    advanced: { useSecureCookies: false, cookiePrefix: "cubby" },
  })("last_write", {
    httpOnly: false,
    secure:
      configuration.NODE_ENV === "production" &&
      configuration.INSECURE_AUTH_COOKIES !== "true",
    maxAge: HYPERDRIVE_CACHE_POLICY.freshReadSeconds,
    sameSite: "lax",
  });
};

/** No invocation-wide state escapes into queue/cron/DO notifications. */
export const withMemberFreshness = <T>(run: () => Promise<T>): Promise<T> =>
  scope.run({}, run);

export function registerFreshnessMember(member: FreshnessMember): void {
  const current = scope.getStore();
  if (current) current.member = member;
}

/** Conservative after attempted writes too: a failed response can follow a commit. */
export async function recordDatabaseWrite(_source: string): Promise<void> {
  const current = scope.getStore();
  if (current?.member) current.lastWriteAt = Date.now();
}

export async function readMemberMarker(
  headers: Headers,
  member: FreshnessMember,
): Promise<MemberReadMarker> {
  const current = scope.getStore();
  if (
    current?.lastWriteAt !== undefined &&
    current.member?.userId === member.userId &&
    current.member.sessionId === member.sessionId
  )
    return { kind: "valid", lastWriteAt: current.lastWriteAt };
  const token =
    headers.get("x-cubby-read-marker") ??
    parseCookies(headers.get("cookie") ?? "").get(MEMBER_WRITE_COOKIE);
  if (token === undefined || token === null) return { kind: "absent" };
  try {
    if (token.length > 2048) return { kind: "invalid" };
    const parsed = markerSchema.safeParse(
      await verifyJWT<unknown>(token, getAuthSecret()),
    );
    if (
      !parsed.success ||
      parsed.data.userId !== member.userId ||
      parsed.data.sessionId !== member.sessionId ||
      parsed.data.lastWriteAt > Date.now()
    )
      return { kind: "invalid" };
    return { kind: "valid", lastWriteAt: parsed.data.lastWriteAt };
  } catch {
    // An invalid or expired marker never grants cache eligibility to an API caller.
    return { kind: "invalid" };
  }
}

/** Also carried in stream envelopes, whose headers precede later commits. */
export async function memberWriteCookie(): Promise<string | undefined> {
  const current = scope.getStore();
  if (!current?.member || current.lastWriteAt === undefined) return undefined;
  try {
    const token = await signJWT(
      {
        purpose: "cubby-last-write",
        ...current.member,
        lastWriteAt: current.lastWriteAt,
      },
      getAuthSecret(),
      HYPERDRIVE_CACHE_POLICY.markerValiditySeconds,
    );
    const cookie = markerCookie();
    return `${cookie.name}=${token}; Path=/; Max-Age=${cookie.attributes.maxAge}; SameSite=Lax${cookie.attributes.secure ? "; Secure" : ""}`;
  } catch (error) {
    // Marker delivery cannot turn an accepted write into a failed save.
    log.warn("Could not sign member write marker", { error });
    return undefined;
  }
}
