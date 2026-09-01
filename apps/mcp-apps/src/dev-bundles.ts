/**
 * Raw MCP App bundle for the Node dev server and Vitest only. Production
 * Workers consume the hashed `?url` export from `bundles.ts` through ASSETS.
 */
export { default as USDA_PICKER_HTML } from "../dist/app.html?raw";
