import type {
  EventCalendarEventId,
  EventCalendarSegment,
} from "./event-calendar-types";

let focusedChip: {
  node: HTMLElement;
  eventId: EventCalendarEventId;
} | null = null;

function captureEventCalendarChipFocus(
  node: HTMLElement,
  eventId: EventCalendarEventId,
) {
  focusedChip = { node, eventId };
}

function releaseEventCalendarChipFocus(node: HTMLElement) {
  if (node.isConnected && focusedChip?.node === node) focusedChip = null;
}

/** Restore focus after a committed move re-keys and remounts the active chip. */
function restoreEventCalendarChipFocus(
  root: HTMLElement | null,
  segments: readonly EventCalendarSegment[],
) {
  const pending = focusedChip;
  if (!root || !pending || pending.node.isConnected) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const index = segments.findIndex(
    (segment) => segment.occurrence.eventId === pending.eventId,
  );
  if (index < 0) return;
  const chip = root.querySelectorAll<HTMLElement>(
    "[data-slot=event-calendar-event]",
  )[index];
  if (!chip) return;
  focusedChip = null;
  chip.focus();
}

export {
  captureEventCalendarChipFocus,
  releaseEventCalendarChipFocus,
  restoreEventCalendarChipFocus,
};
