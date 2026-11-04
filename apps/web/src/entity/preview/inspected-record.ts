import { useSyncExternalStore } from "react";

let inspected: string | null = null;
const listeners = new Set<() => void>();

const keyOf = (entity: string, id: string) => `${entity}:${id}`;

const write = (next: string | null) => {
  inspected = next;
  for (const listener of listeners) listener();
};

/**
 * Publishes the record the open inspector shows; the returned cleanup clears
 * it. The hover preview reads this rather than the list's state because a link
 * to the record can sit in any table beside the inspector.
 */
export function setInspectedRecord(entity: string, id: string) {
  const key = keyOf(entity, id);
  write(key);
  return () => {
    if (inspected === key) write(null);
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** A hover preview of this record would only repeat the inspector beside it. */
export function useIsInspected(entity: string, id: string) {
  return useSyncExternalStore(
    subscribe,
    () => inspected === keyOf(entity, id),
    () => false,
  );
}
