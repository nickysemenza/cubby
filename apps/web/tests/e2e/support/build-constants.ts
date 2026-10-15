// Server modules the e2e fixtures run inside the Playwright process read the
// Vite `define` constants (`vite.config.ts`); nothing substitutes them in Node,
// so the AI-usage recorder logged `__GIT_COMMIT__ is not defined` on every
// seeded write. Mirror the unit tier's values before any server import.
const constants = {
  __GIT_COMMIT__: "e2e",
  __SOURCE_COMMIT__: "e2e",
  __SOURCE_BRANCH__: "e2e",
  __BUILD_DATE__: "2026-01-01T00:00:00.000Z",
  __R2_PUBLIC_URL__: "",
} as const;
for (const [name, value] of Object.entries(constants)) {
  if (!(name in globalThis)) Object.defineProperty(globalThis, name, { value });
}
