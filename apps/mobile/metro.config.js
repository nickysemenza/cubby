// Expo SDK 56 auto-configures the monorepo (watchFolders, node_modules) — don't
// hand-set those. We only ensure the recipebridge WebView host is built before
// bundling: the 3.4 MB generated module is gitignored (not committed), and this
// regenerates it from packages/wasm on `expo start` / `expo export` / EAS. The
// build script is guarded, so it's a no-op when already up to date.
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

execFileSync(
  "node",
  [path.join(__dirname, "scripts/build-recipebridge-host.mjs")],
  { stdio: "inherit" },
);

module.exports = getDefaultConfig(__dirname);
