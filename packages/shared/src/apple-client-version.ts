/**
 * The native app's marketing version and the oldest one the HTTP API serves.
 * Raise it only in the PR that ships a wire-breaking change: a push that
 * changes this value publishes TestFlight builds immediately, and the server
 * answers older apps with HTTP 426 once it deploys. Compatible changes ship in
 * the nightly release without touching it. Three numeric components.
 */
export const APPLE_CLIENT_COMPATIBILITY_VERSION = "2.17.0";
