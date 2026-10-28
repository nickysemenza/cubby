/** Invalidation refetches bypass Hyperdrive without changing other members' policy. */
export const STRONG_READ_HEADER = "x-cubby-read-consistency";
export const MEMBER_WRITE_COOKIE = "cubby.last_write";

/** An aborted response may follow a commit. An unsigned pending claim fails closed. */
export function beginMemberWrite(): void {
  if (typeof document !== "undefined")
    document.cookie = `${MEMBER_WRITE_COOKIE}=pending; Path=/; Max-Age=90; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}

/** Signed by the server; streams deliver it after headers have already been sent. */
export function acceptMemberWriteCookie(cookie: string | undefined): void {
  if (cookie && typeof document !== "undefined") document.cookie = cookie;
}
