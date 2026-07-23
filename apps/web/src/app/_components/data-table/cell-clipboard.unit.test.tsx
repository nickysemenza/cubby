import { afterEach, describe, expect, it, vi } from "vitest";

// Mock sonner toast — handlePaste's rejection path routes through it.
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

import {
  CELL_CLIPBOARD_MIME,
  type CellClipboardSpec,
  registerCellClipboard,
} from "./cell-clipboard";
import { selectCellData, specFromCellData, tagsCellData } from "./cell-data";

/** jsdom's `ClipboardEvent` has no `clipboardData`; attach a mock directly on
 * a plain (cancelable) `Event` — the module only reads `event.clipboardData`
 * and calls `event.preventDefault()`, both of which work on a bare Event. */
function makeClipboardData(
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

function dispatchClipboardEvent(
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

/** Flush the microtask queue (onPasteValue's `.then()` chain) without fake
 * timers — a 0ms macrotask runs strictly after all pending microtasks. */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

function registerFocusedButton(spec: CellClipboardSpec) {
  const el = document.createElement("button");
  document.body.appendChild(el);
  const unregister = registerCellClipboard(el, spec);
  el.focus();
  return { el, unregister };
}

// Track cleanups so a test that throws mid-way doesn't leak a registration
// (and its document listeners) into the next test.
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("registerCellClipboard lifecycle", () => {
  it("installs document listeners on first registration only, and removes them after the last unregister", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const elA = document.createElement("button");
    const elB = document.createElement("button");
    document.body.append(elA, elB);

    const unregisterA = registerCellClipboard(elA, { kindKey: "a" });
    expect(addSpy).toHaveBeenCalledWith("copy", expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith("paste", expect.any(Function));
    const addCallsAfterFirst = addSpy.mock.calls.length;

    // A second concurrent registration must not reinstall listeners.
    const unregisterB = registerCellClipboard(elB, { kindKey: "b" });
    expect(addSpy.mock.calls.length).toBe(addCallsAfterFirst);

    unregisterA();
    expect(removeSpy).not.toHaveBeenCalled();

    unregisterB();
    expect(removeSpy).toHaveBeenCalledWith("copy", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("paste", expect.any(Function));

    // Once listeners are torn down, a copy no longer reaches any handler —
    // even a payload-producing spec (if it were still registered) is never
    // consulted, and the native copy proceeds unhindered.
    const getCopyPayload = vi.fn(() => ({ text: "x", json: "x" }));
    const clipboardData = makeClipboardData();
    const event = dispatchClipboardEvent("copy", clipboardData);
    expect(getCopyPayload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(clipboardData.setData).not.toHaveBeenCalled();

    addSpy.mockRestore();
    removeSpy.mockRestore();
    elA.remove();
    elB.remove();
  });
});

describe("copy", () => {
  it("writes text/plain and the typed JSON payload for a focused registered element, preventDefaults, and flashes 'copied'", () => {
    vi.useFakeTimers();
    const { el, unregister } = registerFocusedButton({
      kindKey: "amount",
      getCopyPayload: () => ({
        text: "3 cups",
        json: { value: 3, unit: "cups" },
      }),
    });
    cleanups.push(unregister);

    const clipboardData = makeClipboardData();
    const event = dispatchClipboardEvent("copy", clipboardData);

    expect(event.defaultPrevented).toBe(true);
    expect(clipboardData.setData).toHaveBeenCalledWith("text/plain", "3 cups");
    expect(clipboardData.setData).toHaveBeenCalledWith(
      CELL_CLIPBOARD_MIME,
      JSON.stringify({
        kind: "amount",
        value: { value: 3, unit: "cups" },
      }),
    );
    expect(el.getAttribute("data-clipboard-flash")).toBe("copied");

    vi.advanceTimersByTime(599);
    expect(el.getAttribute("data-clipboard-flash")).toBe("copied");
    vi.advanceTimersByTime(1);
    expect(el.getAttribute("data-clipboard-flash")).toBeNull();
  });

  it("does not preventDefault or write clipboard data when getCopyPayload returns null", () => {
    const { unregister } = registerFocusedButton({
      kindKey: "x",
      getCopyPayload: () => null,
    });
    cleanups.push(unregister);

    const clipboardData = makeClipboardData();
    const event = dispatchClipboardEvent("copy", clipboardData);

    expect(event.defaultPrevented).toBe(false);
    expect(clipboardData.setData).not.toHaveBeenCalled();
  });
});

describe("paste", () => {
  it("calls onPasteValue with the typed JSON payload when the copied kind matches, and flashes 'pasted' on resolve", async () => {
    const onPasteValue = vi.fn().mockResolvedValue("saved");
    const { el, unregister } = registerFocusedButton({
      kindKey: "entity:location",
      onPasteValue,
    });
    cleanups.push(unregister);

    const clipboardData = makeClipboardData({
      getData: vi.fn((mime: string) =>
        mime === CELL_CLIPBOARD_MIME
          ? JSON.stringify({ kind: "entity:location", value: "loc-1" })
          : "Pantry",
      ),
    });
    const event = dispatchClipboardEvent("paste", clipboardData);

    expect(event.defaultPrevented).toBe(true);
    expect(onPasteValue).toHaveBeenCalledWith({ json: "loc-1" });
    expect(el.getAttribute("data-clipboard-flash")).toBeNull(); // not yet — resolves async

    await flushMicrotasks();
    expect(el.getAttribute("data-clipboard-flash")).toBe("pasted");
  });

  it("falls back to text/plain when the typed payload's kind doesn't match this cell", async () => {
    const onPasteValue = vi.fn().mockResolvedValue("saved");
    const { unregister } = registerFocusedButton({
      kindKey: "number",
      onPasteValue,
    });
    cleanups.push(unregister);

    const clipboardData = makeClipboardData({
      getData: vi.fn((mime: string) =>
        mime === CELL_CLIPBOARD_MIME
          ? JSON.stringify({ kind: "entity:location", value: "loc-1" })
          : "42",
      ),
    });
    const event = dispatchClipboardEvent("paste", clipboardData);

    expect(event.defaultPrevented).toBe(true);
    expect(onPasteValue).toHaveBeenCalledWith({ text: "42" });

    await flushMicrotasks();
  });

  it("ignores paste while isEditing() reports true", () => {
    const onPasteValue = vi.fn();
    const { unregister } = registerFocusedButton({
      kindKey: "x",
      onPasteValue,
      isEditing: () => true,
    });
    cleanups.push(unregister);

    const clipboardData = makeClipboardData();
    const event = dispatchClipboardEvent("paste", clipboardData);

    expect(event.defaultPrevented).toBe(false);
    expect(onPasteValue).not.toHaveBeenCalled();
  });

  it("shows a toast when onPasteValue rejects, and doesn't flash or throw", async () => {
    const { toast } = await import("sonner");
    const onPasteValue = vi.fn().mockRejectedValue(new Error("bad paste"));
    const { el, unregister } = registerFocusedButton({
      kindKey: "x",
      onPasteValue,
    });
    cleanups.push(unregister);

    const clipboardData = makeClipboardData({ getData: vi.fn(() => "text") });
    dispatchClipboardEvent("paste", clipboardData);

    await flushMicrotasks();

    expect(toast.error).toHaveBeenCalledWith("bad paste");
    expect(el.getAttribute("data-clipboard-flash")).toBeNull();
  });
});

describe("specFromCellData select validation", () => {
  const options = [
    { value: "todo", label: "To Do" },
    { value: "done", label: "Done" },
  ];
  const row = { id: "r1" };

  it("saves the matching option value on an exact value match", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const spec = specFromCellData(
      selectCellData<typeof row>(() => "todo", options, save),
      row,
    );
    const saved = await spec.onPasteValue!({ json: "done" });
    expect(save).toHaveBeenCalledWith(row, "done");
    expect(saved).toBe("done");
  });

  it("resolves a case-insensitive label to its option value", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const spec = specFromCellData(
      selectCellData<typeof row>(() => null, options, save),
      row,
    );
    // "TO DO" matches no value but matches the "To Do" label case-insensitively.
    const saved = await spec.onPasteValue!({ text: "TO DO" });
    expect(save).toHaveBeenCalledWith(row, "todo");
    expect(saved).toBe("todo");
  });

  it("rejects a value matching no option, without saving", async () => {
    const save = vi.fn();
    const spec = specFromCellData(
      selectCellData<typeof row>(() => null, options, save),
      row,
    );
    await expect(spec.onPasteValue!({ text: "nope" })).rejects.toThrow(
      '"nope" is not a valid option here',
    );
    expect(save).not.toHaveBeenCalled();
  });
});

describe("tagsCellData", () => {
  interface TagRow {
    id: string;
    tags: string[] | null;
  }

  it("copies a comma-joined text with the raw array as the typed payload", () => {
    const cellData = tagsCellData<TagRow>((row) => row.tags);
    const payload = cellData.getCopyPayload({
      id: "r1",
      tags: ["quick", "cuisine:thai"],
    });
    expect(payload).toEqual({
      text: "quick, cuisine:thai",
      json: ["quick", "cuisine:thai"],
    });
  });

  it("copies null when the row has no tags (null or empty)", () => {
    const cellData = tagsCellData<TagRow>((row) => row.tags);
    expect(cellData.getCopyPayload({ id: "r1", tags: null })).toBeNull();
    expect(cellData.getCopyPayload({ id: "r2", tags: [] })).toBeNull();
  });

  it("pastes a typed json array verbatim", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const cellData = tagsCellData<TagRow>((row) => row.tags, save);
    const row: TagRow = { id: "r1", tags: null };
    const saved = await cellData.applyPaste!(row, {
      json: ["quick", "cuisine:thai"],
    });
    expect(save).toHaveBeenCalledWith(row, ["quick", "cuisine:thai"]);
    expect(saved).toEqual(["quick", "cuisine:thai"]);
  });

  it("splits, trims, and lowercases a text paste, dropping empties", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const cellData = tagsCellData<TagRow>((row) => row.tags, save);
    const row: TagRow = { id: "r1", tags: null };
    const saved = await cellData.applyPaste!(row, {
      text: "Quick, , Cuisine:Thai ,",
    });
    expect(save).toHaveBeenCalledWith(row, ["quick", "cuisine:thai"]);
    expect(saved).toEqual(["quick", "cuisine:thai"]);
  });

  it("clears the column (saves null) when a text paste is empty/blank", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const cellData = tagsCellData<TagRow>((row) => row.tags, save);
    const row: TagRow = { id: "r1", tags: ["quick"] };
    const saved = await cellData.applyPaste!(row, { text: " , " });
    expect(save).toHaveBeenCalledWith(row, null);
    expect(saved).toBeNull();
  });

  it("is read-only for paste when no save is provided", () => {
    const cellData = tagsCellData<TagRow>((row) => row.tags);
    expect(cellData.applyPaste).toBeUndefined();
  });
});

describe("unregistered/unfocused elements", () => {
  it("leaves copy/paste untouched when the focused element isn't the registered one", () => {
    const registeredEl = document.createElement("button");
    document.body.appendChild(registeredEl);
    const getCopyPayload = vi.fn(() => ({ text: "x", json: "x" }));
    const unregister = registerCellClipboard(registeredEl, {
      kindKey: "x",
      getCopyPayload,
    });
    cleanups.push(() => {
      unregister();
      registeredEl.remove();
    });

    const unregisteredEl = document.createElement("button");
    document.body.appendChild(unregisteredEl);
    unregisteredEl.focus(); // focused, but never registered
    cleanups.push(() => unregisteredEl.remove());

    const clipboardData = makeClipboardData();
    const event = dispatchClipboardEvent("copy", clipboardData);

    expect(event.defaultPrevented).toBe(false);
    expect(getCopyPayload).not.toHaveBeenCalled();
    expect(clipboardData.setData).not.toHaveBeenCalled();

    const pasteClipboardData = makeClipboardData();
    const pasteEvent = dispatchClipboardEvent("paste", pasteClipboardData);
    expect(pasteEvent.defaultPrevented).toBe(false);
  });
});
