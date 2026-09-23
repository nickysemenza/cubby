/** Annotation that navigation helpers attach to the running test with the
 * milliseconds spent loading and hydrating a page; the harness reporter sums
 * them so the share of E2E time spent on page loads stays visible. */
export const NAVIGATION_ANNOTATION = "e2e-navigation-ms";

/** Where a page load's time goes, in ms from navigation start: the server's
 * first byte, the full HTML response, DOMContentLoaded, and the moment the
 * helpers saw the shell hydrated. */
export const NAVIGATION_PHASES_ANNOTATION = "e2e-navigation-phases";
