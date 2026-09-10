import type { RouterHistory } from "@tanstack/react-router";

/** Only entries observed in this mounted app count; a direct link has no known predecessor. */
export function createInAppHistory(history: RouterHistory) {
  const entries = new Set([history.location.state.__TSR_index]);
  const getSnapshot = () => entries.has(history.location.state.__TSR_index - 1);
  const subscribe = (notify: () => void) =>
    history.subscribe(({ location, action }) => {
      const index = location.state.__TSR_index;
      if (action.type === "PUSH") {
        for (const entry of entries) if (entry >= index) entries.delete(entry);
        entries.add(index);
      } else if (action.type === "REPLACE") {
        entries.add(index);
      }
      notify();
    });
  return { getSnapshot, subscribe };
}
