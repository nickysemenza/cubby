import { focusManager } from "@tanstack/react-query";

interface ActivityTarget {
  addEventListener(
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListener,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface ActivityDocument extends ActivityTarget {
  visibilityState: DocumentVisibilityState;
}

interface HumanActivityFocusEnvironment {
  document: ActivityDocument;
  window: ActivityTarget;
  isOnline: () => boolean;
}

const ACTIVITY_EVENTS = [
  "pointerdown",
  "touchstart",
  "keydown",
  "wheel",
] as const;

export function createHumanActivityFocusListener(
  environment: HumanActivityFocusEnvironment,
): (handleFocus: (focused?: boolean) => void) => () => void {
  return (handleFocus) => {
    let armed = false;
    const canFocus = () =>
      environment.document.visibilityState === "visible" &&
      environment.isOnline();
    const rearm = () => {
      if (!canFocus()) {
        armed = true;
        handleFocus(false);
      }
    };
    const release: EventListener = (event) => {
      if (!armed || !event.isTrusted || !canFocus()) return;
      armed = false;
      handleFocus(true);
    };
    const eventOptions = { capture: true, passive: true };

    environment.document.addEventListener("visibilitychange", rearm);
    environment.window.addEventListener("offline", rearm);
    environment.window.addEventListener("online", rearm);
    for (const type of ACTIVITY_EVENTS) {
      environment.window.addEventListener(type, release, eventOptions);
    }
    rearm();

    return () => {
      environment.document.removeEventListener("visibilitychange", rearm);
      environment.window.removeEventListener("offline", rearm);
      environment.window.removeEventListener("online", rearm);
      for (const type of ACTIVITY_EVENTS) {
        environment.window.removeEventListener(type, release, eventOptions);
      }
    };
  };
}

let installed = false;

export function installHumanActivityFocusController(): void {
  if (installed) return;
  installed = true;
  focusManager.setEventListener(
    createHumanActivityFocusListener({
      document,
      window,
      isOnline: () => navigator.onLine,
    }),
  );
}
