/** JPEG analysis copies stay bounded even if four photo invocations overlap in one isolate. */
export const MAX_DESCRIPTION_RENDITION_BYTES = 4 * 1024 * 1024;
export const MAX_IDENTIFICATION_RENDITION_BYTES = 2 * 1024 * 1024;
/** The longest edge of each analysis rendition; the device JPEG contract shares 2048. */
export const DESCRIPTION_RENDITION_EDGE = 2048;
export const IDENTIFICATION_RENDITION_EDGE = 1024;
/** The in-process PNG fallback copies its source into WASM; matches the Rust bound. */
export const MAX_ANALYSIS_FALLBACK_SOURCE_BYTES = 16 * 1024 * 1024;
