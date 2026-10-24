/**
 * The native app's marketing version and minimum version allowed to write
 * through the shared operation route. Older builds can break on wire changes;
 * the runner refuses their writes with HTTP 426. Compatible changes ship in
 * the nightly release. Three numeric components.
 */
export const APPLE_CLIENT_COMPATIBILITY_VERSION = "2.66.0";
