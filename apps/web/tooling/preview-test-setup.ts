import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// The app's real Tailwind entry point — components' utility classes (the
// `min-h-11`/`md:min-w-0` touch-target sizing, the `truncate` this tier
// exists to check) only affect layout once this is loaded; jsdom's `ui`
// project never needed it because jsdom has no layout engine to feed.
import "~/styles.css";

// Unlike `ui-test-setup.ts` (jsdom, run in Node), the `preview` project runs
// inside a real Chromium tab: `localStorage`/`sessionStorage` are the
// browser's own implementations, not a Node polyfill, so there is no
// `localStorage` global to patch here. Layout state (computed styles, media
// query matches) is real too and needs no reset — a fresh `render` per test
// already gets a fresh subtree, and `cleanup()` unmounts it.
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});
