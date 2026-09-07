import type {
  chunkRequestInput,
  ImportRecipe,
} from "@cubby/schemas/import-recipe";
import type { z } from "zod";

import type { ExtractionReport, FailedChunk } from "./extraction";

/** Result of importing a single recipe into the DB. */
export type ImportResult =
  | { status: "importing" }
  | { status: "done"; id: string; hasImage?: boolean }
  | { status: "error"; message: string };

/** Photo work is independent from recipe persistence, so a failed photo can retry alone. */
export type PhotoResult =
  | { status: "ready" }
  | { status: "pending" }
  | {
      status: "attached" | "reused" | "skipped-existing";
      cleanupWarning?: string;
    }
  | { status: "missing-bytes"; message: string }
  | { status: "error"; message: string; cleanupWarning?: string };

/** Where a book is in the in-browser extraction pipeline. */
export type ExtractPhase =
  | { status: "pending" }
  | { status: "extracting"; done: number; total: number }
  | { status: "ready"; failedChunks: FailedChunk[]; report?: ExtractionReport }
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
  /** Current extraction differs from the raw JSON persisted for cookbookId. */
  needsCookbookUpsert?: boolean;
  /** Original EPUB bytes are available in this browser session for archive photos. */
  hasArchiveBytes?: boolean;
  /** Selected recipe indices into `recipes`. */
  selected: Set<number>;
  /** Per-recipe import status, by index. */
  results: Map<number, ImportResult>;
  /** Per-recipe EPUB-photo outcome, separate from the recipe import result. */
  photos: Map<number, PhotoResult>;
  /** Transient object URLs for archive-image previews, keyed by recipe index. */
  photoPreviewUrls: Map<number, string>;
  /** Overall import progress while `importCookbookStream` runs; absent when idle. */
  importProgress?: { done: number; total: number };
  /** Photo attachment progress, absent when no photo work is in flight. */
  photoProgress?: { done: number; total: number };
  extract: ExtractPhase;
  expanded: boolean;
};

/**
 * Input to the `recipe.extractCookbookChunk` proxy (camelCased WASM request).
 * Sourced from the procedure's `chunkRequestInput` schema so it can't drift
 * from the workflow boundary. `escalate` asks the server-owned proxy for the
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
  retryPhoto: (source: string, index: number) => void | Promise<void>;
  bindOriginalEpub: (source: string, file: File) => void | Promise<void>;
  /** Re-run extraction for this book from its cached EPUB bytes (retry failed chunks). */
  retryExtraction: (source: string) => void;
};
