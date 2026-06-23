import type { ImportRecipe } from "@cubby/schemas/import-recipe";

/** Result of importing a single recipe into the DB. */
export type ImportResult =
  | { status: "importing" }
  | { status: "done"; id: string }
  | { status: "error"; message: string };

/** Where a book is in the in-browser extraction pipeline. */
export type ExtractPhase =
  | { status: "pending" }
  | { status: "extracting"; done: number; total: number }
  | { status: "ready"; failedChunks: number }
  | { status: "error"; message: string };

/** One cookbook being reviewed/imported (one dropped .epub, or one JSON source). */
export type Book = {
  /** Group identity: the .epub filename, or a recipe's `source` (JSON path). */
  source: string;
  /** Editable display/import name (the value stamped as the recipe's book). */
  name: string;
  recipes: ImportRecipe[];
  /** Book-level OPF metadata read from the EPUB (empty for the JSON path). */
  epubMeta?: { author: string[]; subjects: string[] };
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

/** Input to the `recipe.extractCookbookChunk` proxy (camelCased WASM request). */
export type ChunkRequestInput = {
  system: string;
  user: string;
  toolName: string;
  toolSchema: Record<string, unknown>;
  /** Ask the server-owned proxy for the stronger escalation model. Set by the
   * Rust driver only after the default model returned unparseable output. */
  escalate?: boolean;
};

/** Callbacks the parent passes to each {@link Book} card. */
export type BookHandlers = {
  rename: (source: string, name: string) => void;
  toggleRecipe: (source: string, index: number) => void;
  toggleAll: (source: string) => void;
  toggleExpanded: (source: string) => void;
  remove: (source: string) => void;
  import: (source: string) => void | Promise<void>;
};
