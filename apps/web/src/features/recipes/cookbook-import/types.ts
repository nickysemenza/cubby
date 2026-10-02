import type { Progress } from "@cubby/recipebridge";
import type {
  CookbookExtraction,
  CookbookRunReport,
} from "@cubby/schemas/cookbook";

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

/**
 * A cost/time estimate taken before the first model call. Copied out of the
 * crate's `Estimate` (a wasm-owned object) into plain values for rendering.
 */
export type BookEstimate = {
  chunks: number;
  lines: number;
  inputTokens: number;
  outputTokens: number;
  costLow: number;
  costHigh: number;
  wallMsLow: number;
  wallMsHigh: number;
  ladder: string[];
  concurrency: number;
  assumptions: string[];
};

/**
 * Where a book is in the in-browser extraction pipeline.
 *
 * `opened` is a resting state, not a transient one: opening an EPUB and
 * estimating it are free, extracting it is not, so a book waits there until the
 * user clicks Extract. Cancelling returns a book to `opened` rather than to
 * `error` — nothing went wrong, and the kept bytes open a fresh book to retry
 * (the crate refuses to extract a cancelled book a second time).
 */
export type ExtractPhase =
  | { status: "opening" }
  | { status: "opened" }
  | { status: "extracting"; progress: Progress | null }
  | { status: "ready" }
  | { status: "error"; message: string };

/** Book-level metadata read from the EPUB's OPF (absent on the JSON path). */
type BookMeta = {
  author: string[];
  subjects: string[];
  /** Canonical GTIN-14 from the OPF's `<dc:identifier>`s; null if none is an ISBN. */
  isbn: string | null;
};

/** What the outline says about a book before anything is extracted. */
type BookOutlineView = {
  title: string;
  authors: string[];
  chapters: number;
  navRecipeTitles: number;
  lines: number;
};

/** One cookbook being reviewed/imported (one dropped .epub, one JSON file, or one stored source). */
export type Book = {
  /** Group identity: the .epub filename, the JSON filename, or a cookbook id. */
  source: string;
  /** Editable display/import name (the value stamped as the recipe's book). */
  name: string;
  outline?: BookOutlineView;
  estimate?: BookEstimate;
  /** The extracted book tree; absent until extraction (or a load) produces one. */
  extraction?: CookbookExtraction;
  /** The run's diagnostics. Null for a JSON load, which has no run. */
  report?: CookbookRunReport | null;
  meta?: BookMeta;
  /** Cover image read from the EPUB (absent for JSON / from-source paths). */
  cover?: { bytes: Uint8Array; mime: string };
  /** Object URL for the cover, so the card can show it before import. */
  coverPreviewUrl?: string;
  /**
   * Set when this Book was re-opened from a cookbook's stored tree (the "add
   * from source" path). The cookbook already exists, so `importBook` skips
   * `upsertCookbook` and imports straight against this id.
   */
  cookbookId?: string;
  /** Current extraction differs from the tree persisted for cookbookId. */
  needsCookbookUpsert?: boolean;
  /** The original EPUB is open in this browser session, so photos can be read. */
  hasArchiveBytes?: boolean;
  /** Selected tree item ids (recipe items only). */
  selected: Set<string>;
  /** Per-recipe import status, by tree item id. */
  results: Map<string, ImportResult>;
  /** Per-recipe EPUB-photo outcome, separate from the recipe import result. */
  photos: Map<string, PhotoResult>;
  /** Transient object URLs for archive-image previews, by tree item id. */
  photoPreviewUrls: Map<string, string>;
  /** Overall import progress while `importCookbookStream` runs; absent when idle. */
  importProgress?: { done: number; total: number };
  /** Photo attachment progress, absent when no photo work is in flight. */
  photoProgress?: { done: number; total: number };
  extract: ExtractPhase;
  expanded: boolean;
};

/** Callbacks the parent passes to each {@link Book} card. */
export type BookHandlers = {
  rename: (source: string, name: string) => void;
  toggleRecipe: (source: string, id: string) => void;
  toggleAll: (source: string) => void;
  toggleExpanded: (source: string) => void;
  remove: (source: string) => void;
  import: (source: string) => void | Promise<void>;
  retryPhoto: (source: string, id: string) => void | Promise<void>;
  bindOriginalEpub: (source: string, file: File) => void | Promise<void>;
  /** Start extraction for a book that is open and estimated. */
  extract: (source: string) => void;
  /** Stop an extraction in flight; the book returns to `opened`. */
  cancel: (source: string) => void;
  /** Re-open the book from its kept EPUB bytes and extract again. */
  retryExtraction: (source: string) => void;
};
