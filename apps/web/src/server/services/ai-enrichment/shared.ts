/**
 * Small helpers shared across the ai-enrichment modules. Must not import from
 * any sibling module in this directory (kept import-cycle-free on purpose).
 */

// Defined by Vite for the Cloudflare build only; guard before reading (mirrors
// db.ts). Used only as a "prod"/"dev" label for AI Gateway metadata here.
declare const __CF_WORKERS__: boolean | undefined;
export const IS_CF_WORKERS =
  typeof __CF_WORKERS__ !== "undefined" && __CF_WORKERS__ === true;

// Drive a chat() loop to completion. Tool handlers capture results via closures,
// so we only watch for run errors here: chat() delivers provider/transport
// failures as a RUN_ERROR chunk rather than throwing, and an unsurfaced one looks
// like "no match" to the caller. Shared by both search-then-select flows below.
export async function drainChat(
  stream: AsyncIterable<unknown>,
  label: string,
): Promise<void> {
  for await (const chunk of stream) {
    const type = (chunk as { type?: string })?.type ?? "";
    if (type.includes("ERROR")) {
      console.error(
        `[${label}] run error:`,
        (chunk as { message?: string }).message ?? JSON.stringify(chunk),
      );
    }
  }
}
