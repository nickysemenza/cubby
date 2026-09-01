/**
 * `apps/web` consumes this built document as a static asset. The Worker fetches
 * it through its ASSETS binding on the first resource read, so the document is
 * hashed and served by the asset pipeline rather than embedded in the Worker.
 */
export { USDA_PICKER } from "./metadata";
export { default as USDA_PICKER_HTML_URL } from "../dist/app.html?url";

export { withCubbyOrigin } from "./origin";
