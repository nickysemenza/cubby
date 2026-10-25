/**
 * The oldest Apple build allowed to write through the shared operation route;
 * older builds get HTTP 426. Raise it only when an older build's writes would
 * be unsafe; a changed read or wire shape alone does not require it. Raising
 * it publishes TestFlight promptly so a compatible build exists.
 */
export const APPLE_CLIENT_MINIMUM_VERSION = "2.70.0";

/**
 * The marketing version TestFlight builds carry; each upload gets a new build
 * number, so a release needs no change here. Must not be older than
 * {@link APPLE_CLIENT_MINIMUM_VERSION}. Publish promptly with a workflow
 * dispatch, not a bump.
 */
export const APPLE_MARKETING_VERSION = "2.70.0";
