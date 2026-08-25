/**
 * `apps/web` consumes this built document to register the one `ui://` resource.
 * It is inlined because a Cloudflare Worker has no filesystem to read at request
 * time.
 */
export { USDA_PICKER } from "./metadata";
export { default as USDA_PICKER_HTML } from "../dist/app.html?raw";

export { withCubbyOrigin } from "./origin";
