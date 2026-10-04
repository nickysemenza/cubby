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
