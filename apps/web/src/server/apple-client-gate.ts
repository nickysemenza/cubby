import { APPLE_CLIENT_COMPATIBILITY_VERSION } from "@cubby/shared/apple-client-version";

// The oldest native app build the HTTP API still serves is the version this
// checkout's app ships. An older build would otherwise fail deep inside a
// generated decoder; the gate turns that into one actionable message.

/**
 * `ClientIdentity.userAgent` in CubbyKit: `<product>/<version> (<platform>; <install>)`.
 * Only the app (`cubby-apple`) is gated: the CLI and the unidentified default
 * are built from the same checkout as the server they talk to.
 */
const appleAppUserAgent = /^cubby-apple\/(?<version>\S+)/u;
const dottedVersion = /^\d+(?:\.\d+){0,2}$/u;

const parts = (version: string) => version.split(".").map(Number);

const isOlder = (version: string, minimum: string) => {
  const left = parts(version);
  const right = parts(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
};

/**
 * The offending version when the request comes from a native app build older
 * than the minimum, else null. A missing header, another client, or a version
 * the app could not read from its bundle (`unknown`) is never gated.
 */
export function appleClientUpdateRequired(
  headers: Headers,
): { current: string; minimum: string } | null {
  const current = appleAppUserAgent.exec(headers.get("user-agent") ?? "")
    ?.groups?.version;
  if (
    current === undefined ||
    !dottedVersion.test(current) ||
    !isOlder(current, APPLE_CLIENT_COMPATIBILITY_VERSION)
  )
    return null;
  return { current, minimum: APPLE_CLIENT_COMPATIBILITY_VERSION };
}
