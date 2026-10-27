// Server modules the e2e fixtures run inside the Playwright process read the
// Vite `define` constants (`vite.config.ts`); nothing substitutes them in Node.
// Mirror the unit tier's values before any server import.
const constants = {
  __R2_PUBLIC_URL__: "",
} as const;
for (const [name, value] of Object.entries(constants)) {
  if (!(name in globalThis)) Object.defineProperty(globalThis, name, { value });
}
