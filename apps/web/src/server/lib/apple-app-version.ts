import { APPLE_CLIENT_MINIMUM_VERSION } from "@cubby/shared/apple-client-version";

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
