import { vi } from "vitest";

/**
 * Shared clipboard-event fixtures for the cell copy/paste unit tests
 * (cell-clipboard / cell-edit-trigger). jsdom's `ClipboardEvent` has no
 * `clipboardData`, so we attach a mock directly on a plain (cancelable)
 * `Event` — the clipboard code only reads `event.clipboardData` and calls
 * `event.preventDefault()`, both of which work on a bare Event.
 */
export function makeClipboardData(
  overrides?: Partial<{
    setData: ReturnType<typeof vi.fn>;
    getData: ReturnType<typeof vi.fn>;
  }>,
) {
  return {
    setData: vi.fn(),
    getData: vi.fn(() => ""),
    ...overrides,
  };
}

export function dispatchClipboardEvent(
  type: "copy" | "paste",
  clipboardData: ReturnType<typeof makeClipboardData>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: clipboardData,
    configurable: true,
  });
  document.dispatchEvent(event);
  return event;
}
