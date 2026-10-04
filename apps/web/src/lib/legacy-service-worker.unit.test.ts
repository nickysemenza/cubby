import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

// Installed PWAs and old browser tabs still have a service worker registered
// at /sw.js. A 404 leaves it serving stale precached assets, so the URL must
// keep resolving to a worker that removes itself.
describe("retired service worker at /sw.js", () => {
  it("unregisters itself, clears caches, and reloads controlled pages", async () => {
    const source = readFileSync(resolve("public/sw.js"), "utf8");
    type Listener = (event: {
      waitUntil?: (work: Promise<unknown>) => void;
    }) => void;
    const listeners = new Map<string, Listener>();
    const unregister = vi.fn(async () => true);
    const deleteCache = vi.fn(async () => true);
    const navigate = vi.fn(async () => undefined);
    const skipWaiting = vi.fn();
    const scope = {
      addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
      skipWaiting,
      registration: { unregister },
      clients: { matchAll: async () => [{ url: "/", navigate }] },
      caches: { keys: async () => ["a", "b"], delete: deleteCache },
    };
    runInNewContext(source, { self: scope, caches: scope.caches });

    expect(listeners.has("fetch")).toBe(false);
    listeners.get("install")?.({});
    expect(skipWaiting).toHaveBeenCalled();

    let pending: Promise<unknown> = Promise.resolve();
    listeners.get("activate")?.({
      waitUntil: (p: Promise<unknown>) => (pending = p),
    });
    await pending;

    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("is no longer advertised: no manifest, install assets, or splash images", () => {
    const root = readFileSync(resolve("src/routes/__root.tsx"), "utf8");

    expect(root).not.toMatch(
      /rel:\s*"manifest"|apple-touch|apple-mobile-web-app/,
    );
    const lingering = [
      "manifest.json",
      "apple-touch-icon.png",
      "icon-192.png",
      "icon-512.png",
      "icon-512-maskable.png",
      "splash",
    ].filter((asset) => existsSync(resolve("public", asset)));
    expect(lingering).toEqual([]);
  });
});
