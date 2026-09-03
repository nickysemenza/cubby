import { describe, expect, it, vi } from "vitest";

import { createHumanActivityFocusListener } from "./human-activity-focus";

class FakeTarget {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, isTrusted = true): void {
    for (const listener of this.listeners.get(type) ?? []) {
      // SAFETY: the controller reads only Event.isTrusted; this focused fake
      // supplies that complete owned contract without fabricating a DOM event.
      listener({ isTrusted } as Event);
    }
  }
}

describe("human activity focus controller", () => {
  it.each([
    ["hidden", true],
    ["visible", false],
  ] as const)(
    "keeps initial navigation focused when starting %s and online=%s",
    (visibilityState, online) => {
      const window = new FakeTarget();
      class FakeDocument extends FakeTarget {
        visibilityState: DocumentVisibilityState = visibilityState;
      }
      const document = new FakeDocument();
      const handleFocus = vi.fn();
      const cleanup = createHumanActivityFocusListener({
        document,
        window,
        isOnline: () => online,
      })(handleFocus);

      expect(handleFocus).not.toHaveBeenCalled();
      cleanup();
    },
  );

  it.each(["pointerdown", "touchstart", "keydown", "wheel"])(
    "releases a sleeping tab on trusted %s",
    (activity) => {
      const window = new FakeTarget();
      class FakeDocument extends FakeTarget {
        visibilityState: DocumentVisibilityState = "visible";
      }
      const document = new FakeDocument();
      let online = true;
      const handleFocus = vi.fn();
      const cleanup = createHumanActivityFocusListener({
        document,
        window,
        isOnline: () => online,
      })(handleFocus);

      expect(handleFocus).not.toHaveBeenCalled();
      document.visibilityState = "hidden";
      document.dispatch("visibilitychange");
      document.visibilityState = "visible";
      document.dispatch("visibilitychange");
      window.dispatch("online");
      expect(handleFocus).toHaveBeenCalledTimes(1);
      expect(handleFocus).toHaveBeenLastCalledWith(false);

      window.dispatch(activity, false);
      expect(handleFocus).toHaveBeenCalledTimes(1);
      window.dispatch(activity);
      expect(handleFocus).toHaveBeenLastCalledWith(true);
      window.dispatch(activity);
      expect(handleFocus).toHaveBeenCalledTimes(2);

      online = false;
      window.dispatch("offline");
      online = true;
      window.dispatch("online");
      expect(handleFocus).toHaveBeenCalledTimes(3);
      expect(handleFocus).toHaveBeenLastCalledWith(false);
      window.dispatch(activity);
      expect(handleFocus).toHaveBeenCalledTimes(4);
      expect(handleFocus).toHaveBeenLastCalledWith(true);
      cleanup();
    },
  );
});
