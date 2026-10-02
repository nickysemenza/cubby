import { createCachedLoader } from "~/lib/lazy-preload";
import { recordCommandSearch } from "~/lib/perf/perf-store";

/** Stable command-menu chunk loader shared by the app shell and nav controls. */
const importCommandMenu = createCachedLoader(async () => {
  const startedAt = performance.now();
  const module = await import("./command-menu");
  recordCommandSearch({
    phase: "chunk-preload",
    durationMs: performance.now() - startedAt,
    resultCount: 0,
    scoped: false,
    queryLength: 0,
  });
  return module;
});

let openStartedAt: number | undefined;

export const markCommandMenuOpen = (): void => {
  openStartedAt = performance.now();
};

export const recordCommandMenuOpened = (): void => {
  if (openStartedAt === undefined) return;
  recordCommandSearch({
    phase: "chunk-open",
    durationMs: performance.now() - openStartedAt,
    resultCount: 0,
    scoped: false,
    queryLength: 0,
  });
  openStartedAt = undefined;
};

/** Begin fetching the palette chunk without mounting it. Safe to call repeatedly. */
export const preloadCommandMenu = (): void => {
  void importCommandMenu();
};

/** React.lazy-compatible loader for the palette component. */
export const loadCommandMenu = () =>
  importCommandMenu().then((module) => ({ default: module.GlobalCommandMenu }));
