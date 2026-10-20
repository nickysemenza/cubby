/**
 * Constants every client must agree on. `pnpm generate` emits these into
 * CubbyKit (`Generated/SharedConstants.swift`); never restate one in Swift.
 */

/**
 * Cloudflare image-transform rungs. Every request asks for 2x its rendered
 * width and snaps UP to a rung, so all clients mint the same URL per size and
 * share one edge-cache entry (`golden-vectors/image-url.json`).
 */
export const IMAGE_WIDTHS = [128, 640, 2048] as const;

/**
 * Task board swimlane titles that no record carries: the lane for tasks with no
 * project, and the fallback for a project with no name. Web and native name
 * their lanes with these, beside each task row's own `projectName`.
 */
export const TASK_BOARD_INBOX_LABEL = "Inbox";
export const TASK_BOARD_UNTITLED_PROJECT_LABEL = "Untitled project";

/**
 * Single-user household — hardcoded rather than configurable. Day boundaries
 * (`golden-vectors/household-day.json`) are computed in this zone on every
 * client, wherever the device is.
 */
export const HOUSEHOLD_TIMEZONE = "America/Los_Angeles";

/** Statuses in which a Run is still moving: clients poll and show the live variants only then. */
/**
 * Set to `snapshot` on a Run agent `/stream` answer that is one retained frame
 * rather than a held push stream, so the observer does not treat it as live.
 */
export const AGENT_OBSERVATION_HEADER = "x-cubby-agent-observation";

export const ACTIVE_RUN_STATUSES = [
  "running",
  "paused",
  "paused_auth",
  "paused_offline",
] as const;

/**
 * The most photos one photo-inventory Run holds. Review and the grouping
 * agent read a whole Run at once, so finalize refuses photos past it and
 * every photo picker caps a selection at it.
 */
export const PHOTO_RUN_IMAGE_LIMIT = 500;

/** The longest reason for leaving a prepared import line's Product unresolved. */
export const PRODUCT_DECISION_REASON_MAX = 1_000;

/** Distinct-from evidence bounds shared by import validation and native entry. */
export const DISTINCT_FROM_QUOTE_MAX = 2_000;
export const DISTINCT_FROM_URL_MAX = 2_048;
