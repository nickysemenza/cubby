/** Component previews run without Start's server compiler. Server request
 * storage cannot exist in Chromium; reaching it is a missing read seam, not
 * an invitation to emulate a server context. Real HTTP journeys own that path. */
export function getStartContext(): never {
  throw new Error(
    "Server request context is unavailable in a component preview",
  );
}
export function runWithStartContext(): never {
  throw new Error(
    "Server request context is unavailable in a component preview",
  );
}
