/**
 * Module-level typed copy buffer for range copy/paste. Pure, alias-free
 * (only imports types from `./cell-clipboard-model`) — a single in-memory slot that
 * remembers the last copied grid alongside its TSV serialization, so a
 * same-app paste can recover the typed `json`/`kind` payload even though the
 * system clipboard only round-trips plain text.
 */

import type { CopiedGrid } from "./cell-clipboard-model";

interface CopyBufferEntry {
  grid: CopiedGrid;
  tsv: string;
}

let buffer: CopyBufferEntry | null = null;

export function setCopyBuffer(grid: CopiedGrid, tsv: string): void {
  buffer = { grid, tsv };
}

export function getCopyBuffer(): CopyBufferEntry | null {
  return buffer;
}

/** Trim-normalized comparison: ignores trailing whitespace/newlines the
 * system clipboard (or an intermediate paste target) may add. */
export function bufferMatches(clipboardText: string): boolean {
  if (!buffer) return false;
  return buffer.tsv.trimEnd() === clipboardText.trimEnd();
}

/** For tests. */
export function clearCopyBuffer(): void {
  buffer = null;
}
