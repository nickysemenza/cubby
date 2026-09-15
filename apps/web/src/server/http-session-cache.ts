/** Better Auth owns cookie signatures, expiry, and authoritative session lookup. */
interface HttpSessionResult {
  response: {
    user: { id: string };
    session: { id: string; token: string };
  } | null;
  headers: Headers;
}

export type HttpSessionReader = (options: {
  headers: Headers;
  query?: { disableCookieCache: true };
  returnHeaders: true;
}) => Promise<HttpSessionResult>;

const sessionTokenCookie =
  /^(?:__Secure-)?better-auth\.session_token(?:\.\d+)?$/u;

/** Explicit bearer credentials must never inherit an ambient browser identity. */
export async function authenticateHttpSession(options: {
  headers: Headers;
  getSession: HttpSessionReader;
}): Promise<HttpSessionResult> {
  const headers = new Headers(options.headers);
  const authorization = headers.get("authorization");
  let bearerToken: string | undefined;
  if (authorization !== null && /^bearer(?:\s|$)/iu.test(authorization)) {
    const match = /^bearer\s+(\S+)\s*$/iu.exec(authorization);
    if (!match?.[1]) return { response: null, headers: new Headers() };
    let signedToken: string;
    try {
      signedToken = decodeURIComponent(match[1]);
    } catch {
      return { response: null, headers: new Headers() };
    }
    const separator = signedToken.indexOf(".");
    if (separator <= 0 || separator === signedToken.length - 1) {
      return { response: null, headers: new Headers() };
    }
    // This extracts identity only. The Better Auth bearer plugin verifies the signature.
    bearerToken = signedToken.slice(0, separator);
    headers.set("authorization", `Bearer ${signedToken}`);
    const cookies = (headers.get("cookie") ?? "")
      .split(";")
      .filter(
        (cookie) =>
          !sessionTokenCookie.test(cookie.split("=", 1)[0]?.trim() ?? ""),
      )
      .map((cookie) => cookie.trim())
      .filter(Boolean);
    if (cookies.length) headers.set("cookie", cookies.join("; "));
    else headers.delete("cookie");
  }

  let result = await options.getSession({ headers, returnHeaders: true });
  if (
    bearerToken &&
    result.response &&
    result.response.session.token !== bearerToken
  ) {
    // The installed Better Auth version validates the cache signature but does
    // not bind its cached session to the bearer token injected by the plugin.
    result = await options.getSession({
      headers,
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    if (result.response && result.response.session.token !== bearerToken) {
      return { response: null, headers: new Headers() };
    }
  }
  return result;
}
