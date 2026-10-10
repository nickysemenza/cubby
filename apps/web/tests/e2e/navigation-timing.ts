/** Annotation that navigation helpers attach to the running test with the
 * milliseconds spent loading and hydrating a page; the HTML report shows it
 * beside each test. */
export const NAVIGATION_ANNOTATION = "e2e-navigation-ms";

/** Where a page load's time goes, in ms from navigation start: the server's
 * first byte, the full HTML response, DOMContentLoaded, and the moment the
 * helpers saw the shell hydrated. */
export const NAVIGATION_PHASES_ANNOTATION = "e2e-navigation-phases";
