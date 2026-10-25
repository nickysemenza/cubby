import { APPLE_CLIENT_MINIMUM_VERSION } from "@cubby/shared/apple-client-version";

// Old builds can break when the shared operation wire changes. The compatibility
// gate keeps those builds from submitting writes with an obsolete input shape.

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
 * Whether an Apple app version is older than the write minimum. An absent or
 * unreadable version (`unknown`) is never gated; `Device.updateRequired`
 * reads a stored `appVersion` with the same rule.
 */
export const appleAppVersionTooOld = (version: string | null | undefined) =>
  version !== null &&
  version !== undefined &&
  dottedVersion.test(version) &&
  isOlder(version, APPLE_CLIENT_MINIMUM_VERSION);

/**
 * The offending version when the request comes from a native app build older
 * than the minimum, else null. A missing header or another client is never
 * gated.
 */
export function appleClientUpdateRequired(
  headers: Headers,
): { current: string; minimum: string } | null {
  const current = appleAppUserAgent.exec(headers.get("user-agent") ?? "")
    ?.groups?.version;
  if (current === undefined || !appleAppVersionTooOld(current)) return null;
  return { current, minimum: APPLE_CLIENT_MINIMUM_VERSION };
}

/** The shared operation route's actionable response for an obsolete Apple write. */
export function appleClientUpdateError(
  outdated: NonNullable<ReturnType<typeof appleClientUpdateRequired>>,
) {
  return {
    code: "UPGRADE_REQUIRED" as const,
    reason: "CLIENT_UPDATE_REQUIRED" as const,
    message: `Cubby ${outdated.current} is too old for this server (minimum ${outdated.minimum}). Update Cubby from TestFlight.`,
  };
}
