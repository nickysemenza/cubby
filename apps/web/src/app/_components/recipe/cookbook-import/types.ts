import type {
  chunkRequestInput,
  ImportRecipe,
} from "@cubby/schemas/import-recipe";
import type { z } from "zod";

/** Result of importing a single recipe into the DB. */
export type ImportResult =
  | { status: "importing" }
  | { status: "done"; id: string }
  | { status: "error"; message: string };

/**
 * One chunk that failed extraction — both the default and escalation models
 * returned unparseable output, so its recipes were salvaged (discarded).
 * Mirrors the WASM `WFailedChunk` (camelCased at the boundary).
 */
export type FailedChunk = {
  /** 0-based position in the book's chunk array (from `extract_cookbook`). */
  index: number;
  /** Originating spine-document path (e.g. "OEBPS/text/ch01.xhtml"). */
  docPath: string;
  /** Why the chunk was salvaged (both models produced unparseable output). */
  reason: string;
};

/** Where a book is in the in-browser extraction pipeline. */
export type ExtractPhase =
  | { status: "pending" }
  | { status: "extracting"; done: number; total: number }
  | { status: "ready"; failedChunks: FailedChunk[] }
  | { status: "error"; message: string };

/** One cookbook being reviewed/imported (one dropped .epub, or one JSON source). */
export type Book = {
  /** Group identity: the .epub filename, or a recipe's `source` (JSON path). */
  source: string;
  /** Editable display/import name (the value stamped as the recipe's book). */
  name: string;
  recipes: ImportRecipe[];
  /** Book-level OPF metadata read from the EPUB (empty for the JSON path). */
  epubMeta?: {
    author: string[];
    subjects: string[];
    /** Canonical GTIN-14 from the OPF's `<dc:identifier>`s; null if none is an ISBN. */
    isbn: string | null;
  };
  /** Cover image extracted from the EPUB (empty for JSON / from-source paths). */
  cover?: { bytes: Uint8Array; mime: string };
  /**
   * Set when this Book was re-opened from a cookbook's stored `rawJson` (the
   * "add from source" path). The cookbook already exists, so `importBook` skips
   * `upsertCookbook` and imports straight against this id.
   */
  cookbookId?: string;
  /** Selected recipe indices into `recipes`. */
  selected: Set<number>;
  /** Per-recipe import status, by index. */
  results: Map<number, ImportResult>;
  /** Overall import progress while `importCookbookStream` runs; absent when idle. */
  importProgress?: { done: number; total: number };
  extract: ExtractPhase;
  expanded: boolean;
};

/**
 * Input to the `recipe.extractCookbookChunk` proxy (camelCased WASM request).
 * Sourced from the procedure's `chunkRequestInput` schema so it can't drift
 * from the tRPC boundary. `escalate` asks the server-owned proxy for the
 * stronger escalation model — set by the Rust driver only after the default
 * model returned unparseable output.
 */
export type ChunkRequestInput = z.infer<typeof chunkRequestInput>;

/** Callbacks the parent passes to each {@link Book} card. */
export type BookHandlers = {
  rename: (source: string, name: string) => void;
  toggleRecipe: (source: string, index: number) => void;
  toggleAll: (source: string) => void;
  toggleExpanded: (source: string) => void;
  remove: (source: string) => void;
  import: (source: string) => void | Promise<void>;
  /** Re-run extraction for this book from its cached EPUB bytes (retry failed chunks). */
  retryExtraction: (source: string) => void;
};
