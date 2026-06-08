import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { del, get, set } from "idb-keyval";
import superjson from "superjson";

// Client-only IndexedDB persister for the React Query cache. IndexedDB (not
// localStorage) because inventory/recipe lists can exceed the ~5 MB localStorage
// cap, and async storage keeps serialization off the critical render path.
// Reuses superjson so persisted data round-trips the same Date/Set/Map shapes
// the app already serializes over the wire.
export const persister =
  typeof window === "undefined"
    ? undefined
    : createAsyncStoragePersister({
        key: "cubby-query-cache",
        storage: {
          getItem: (k) => get(k),
          setItem: (k, v) => set(k, v),
          removeItem: (k) => del(k),
        },
        serialize: superjson.stringify,
        deserialize: superjson.parse,
      });
