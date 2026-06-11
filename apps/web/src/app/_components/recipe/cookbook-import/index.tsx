import type { WCookbookChunk } from "@cubby/recipebridge";
import { cookbookBundleSchema } from "@cubby/schemas/cookbook";
import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import {
  ALLOWED_IMAGE_TYPES,
  type AllowedImageType,
} from "@cubby/schemas/image";
import {
  type ImportRecipe,
  importRecipesSchema,
} from "@cubby/schemas/import-recipe";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { useTRPC } from "~/trpc/react";
import { BookGroupCard } from "./book-group-card";
import { addWithReferences, topoOrderSelected } from "./import-order";
import type {
  Book,
  ChunkRequestInput,
  ExtractPhase,
  ImportResult,
} from "./types";

// food-cli / the WASM extractor pass the .epub filename as `source`; turn it
// into a clean, editable book label that stays stable across re-imports.
const deriveBookName = (source: string): string => {
  const base = source.split(/[/\\]/).pop() ?? source;
  return base.replace(/\.epub$/i, "");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker),
  );
  return results;
}

/** Retry with exponential backoff; resolves with the first success. */
async function withRetry<R>(fn: () => Promise<R>, attempts = 3): Promise<R> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastErr = error;
      if (attempt < attempts - 1) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

// Session cache of chunk-id → raw LLM tool output. Keyed by the sha256 the WASM
// computes over the chunk text, so a manual "retry this book" (or two books
// sharing boilerplate) doesn't re-pay an already-extracted chunk this session.
// Not persisted — this is a one-off import flow.
const chunkCache = new Map<string, unknown>();

// Chunks per book extracted concurrently. Matches the native `recipe-epub`
// extractor's default (`Options.concurrency`). Books extract one at a time, so
// this is the ceiling on simultaneous gateway calls — comfortably within
// Gemini-flash rate limits. (In dev over HTTP/1.1 the browser caps ~6 in-flight
// to one origin anyway; prod is HTTP/2 and multiplexes.)
const CHUNK_CONCURRENCY = 8;

// Min gap between live-preview re-assembles during extraction. Each re-assemble
// re-renders the whole growing card list (re-parsing every ingredient line), so
// without this an 8-chunk burst would fire 8 heavy renders back-to-back.
const PREVIEW_THROTTLE_MS = 600;

/**
 * Import cookbooks by dragging `.epub` files straight into Cubby. Each book is
 * extracted entirely in the browser: WASM (`recipebridge.chunk_epub`) splits the
 * EPUB into text chunks carrying ready-to-send LLM requests; the orchestration
 * loop here sends each through `recipe.extractCookbookChunk` (which holds the
 * gateway key) with retry + a session cache; `recipebridge.assemble_recipes`
 * folds the per-chunk outputs back into recipes. The reviewed recipes import via
 * `recipe.insertCookbook`, upserting by (book, title). A flat/bundled JSON file
 * is still accepted as a power-user path.
 */
export function CookbookImport({
  loadCookbookId,
}: {
  /** When set, re-open this cookbook's stored extraction for selective re-import. */
  loadCookbookId?: string;
}) {
  const api = useTRPC();
  const extractChunk = useMutation(
    api.recipe.extractCookbookChunk.mutationOptions(),
  );
  const upsertCookbook = useMutation(
    api.recipe.upsertCookbook.mutationOptions(),
  );
  const insertCookbook = useMutation(
    api.recipe.insertCookbook.mutationOptions(),
  );
  const uploadImageMut = useMutation(api.image.uploadImage.mutationOptions());

  const [books, setBooks] = useState<Book[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputId = useId();
  const jsonInputId = useId();

  // Upload raw image bytes through the presigned-R2 flow (mirrors PendingImageUpload):
  // initiate → PUT to the presigned URL → return the new (PENDING) image id.
  const uploadImageBytes = useCallback(
    async (
      bytes: Uint8Array,
      mime: string,
      filename: string,
    ): Promise<string> => {
      const init = await uploadImageMut.mutateAsync({
        filename,
        contentType: mime as AllowedImageType,
        size: bytes.byteLength,
        entityType: "COOKBOOK",
      });
      // Copy into a fresh ArrayBuffer-backed buffer (a valid BodyInit, and sidesteps
      // the Uint8Array<ArrayBufferLike> vs ArrayBuffer lib-type mismatch).
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      const res = await fetch(init.uploadUrl, {
        method: "PUT",
        body: buf,
        headers: { "Content-Type": mime },
      });
      if (!res.ok) throw new Error(`Storage error (${res.status})`);
      return init.imageId;
    },
    [uploadImageMut],
  );

  // "Add from source": re-open a cookbook's stored extraction as a ready Book so
  // the user can selectively re-import (no EPUB, no LLM). The cookbookId marks it
  // so importBook skips upsertCookbook; BookGroupCard flags already-imported titles.
  const source = useQuery(
    api.recipe.getCookbookSource.queryOptions(
      { cookbookId: unsafeCookbookId(loadCookbookId ?? "") },
      { enabled: !!loadCookbookId },
    ),
  );
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!source.data || seeded) return;
    const { id, name, recipes } = source.data;
    setBooks((prev) =>
      prev.some((b) => b.cookbookId === id)
        ? prev
        : [
            ...prev,
            {
              source: name,
              name,
              cookbookId: id,
              recipes,
              selected: new Set<number>(),
              results: new Map<number, ImportResult>(),
              extract: { status: "ready", failedChunks: 0 },
              expanded: true,
            },
          ],
    );
    setSeeded(true);
  }, [source.data, seeded]);

  // Mutate one book in place by source key; always produces a new array so React
  // re-renders, and a new Set/Map where those change (no in-place mutation).
  const updateBook = useCallback((source: string, patch: (b: Book) => Book) => {
    setBooks((prev) => prev.map((b) => (b.source === source ? patch(b) : b)));
  }, []);

  const setExtract = useCallback(
    (source: string, extract: ExtractPhase) =>
      updateBook(source, (b) => ({ ...b, extract })),
    [updateBook],
  );

  // Extract one EPUB end to end: chunk in WASM, run the LLM per chunk through the
  // proxy (concurrent, retried, cached, failures degrade to empty), then
  // assemble. A failed chunk yields no recipes rather than sinking the book.
  const extractBook = useCallback(
    async (source: string, bytes: Uint8Array) => {
      // Read book-level OPF metadata (title/authors/subjects) once. Pure WASM,
      // no LLM — used to stamp the Cookbook row and prefer the real title over
      // the filename-derived name. Best-effort: a malformed EPUB just yields none.
      try {
        const meta = wasm.epub_metadata(bytes);
        if (meta) {
          const title = meta.title.trim();
          updateBook(source, (b) => ({
            ...b,
            epubMeta: {
              author: [...meta.authors],
              subjects: [...meta.subjects],
            },
            name: title || b.name,
          }));
        }
      } catch {
        // metadata is optional — proceed with the filename-derived name.
      }

      // Extract the cover image (path+mime via cover_image_ref, then bytes via
      // read_image) while the EPUB bytes are in scope. Stored on the Book (one
      // small image, not the EPUB) and uploaded at import time. Best-effort.
      try {
        const ref = wasm.cover_image_ref(bytes);
        if (ref) {
          const data = wasm.read_image(bytes, ref.path);
          if (data) {
            // Copy out of the WASM-owned buffer into a stable Uint8Array.
            const copy = new Uint8Array(data);
            updateBook(source, (b) => ({
              ...b,
              cover: { bytes: copy, mime: ref.mime },
            }));
          }
        }
      } catch {
        // cover is optional — proceed without it.
      }

      let chunks: WCookbookChunk[];
      const tEpub = performance.now();
      try {
        chunks = wasm.chunk_epub(bytes);
      } catch (error) {
        setExtract(source, {
          status: "error",
          message: getErrorMessage(error),
        });
        return;
      }
      const chunkEpubMs = performance.now() - tEpub;
      if (chunks.length === 0) {
        setExtract(source, {
          status: "error",
          message: "No text found in EPUB",
        });
        return;
      }

      let done = 0;
      let failed = 0;
      setExtract(source, { status: "extracting", done, total: chunks.length });

      // --- profiling: per-call latency, live concurrency, assemble cost ---
      const tBook = performance.now();
      const latencies: number[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      let assembleMs = 0;
      const chunkSizes = chunks.map((c) => c.request.user.length);

      // Freeze measurement: 'longtask' entries are main-thread blocks >50ms.
      let longTasks = 0;
      let longTaskMs = 0;
      let maxLongTaskMs = 0;
      let observer: PerformanceObserver | undefined;
      try {
        observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            longTasks++;
            longTaskMs += e.duration;
            if (e.duration > maxLongTaskMs) maxLongTaskMs = e.duration;
          }
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        // longtask API unsupported (e.g. Safari) — skip freeze metrics.
      }

      // Results accumulate as chunks land (order-independent — `assemble_recipes`
      // matches them to chunks by id). `assemble_recipes` is pure, so we re-run it
      // on the partial set to stream recipes into the preview live. Cross-chunk
      // merges + reference links only fully resolve on the final pass; the live
      // preview self-corrects. Throttled so an 8-chunk burst collapses to one
      // re-render (each re-render re-parses every line, so they're not free).
      const results: { id: string; input: unknown }[] = [];
      let lastPreviewAt = 0;

      const reassemble = (final: boolean) => {
        if (!final) {
          const now = performance.now();
          if (now - lastPreviewAt < PREVIEW_THROTTLE_MS) return;
          lastPreviewAt = now;
        }
        let recipes: ImportRecipe[];
        try {
          const tA = performance.now();
          recipes = importRecipesSchema.parse(
            wasm.assemble_recipes(chunks, results, source),
          );
          assembleMs += performance.now() - tA;
        } catch (error) {
          // A transient partial-parse hiccup is fine mid-flight; only surface it
          // if the *final* assemble fails.
          if (final) {
            setExtract(source, {
              status: "error",
              message: getErrorMessage(error),
            });
          }
          return;
        }
        updateBook(source, (b) => ({
          ...b,
          recipes,
          // Auto-select everything; the import button is gated on `ready`, so
          // re-selecting all each pass doesn't fight the user.
          selected: new Set(recipes.map((_, i) => i)),
          ...(final
            ? { extract: { status: "ready", failedChunks: failed } as const }
            : {}),
        }));
        if (final && recipes.length === 0) {
          toast.warning(`No recipes found in ${deriveBookName(source)}`);
        }
      };

      await mapLimit(chunks, CHUNK_CONCURRENCY, async (chunk) => {
        let input: unknown;
        const cached = chunkCache.get(chunk.id);
        if (cached !== undefined) {
          input = cached;
        } else {
          const request: ChunkRequestInput = {
            system: chunk.request.system,
            user: chunk.request.user,
            toolName: chunk.request.tool_name,
            // WASM emits the schema as a JSON string (a serde_json::Value would
            // cross as a JS Map); parse it back to a plain object.
            toolSchema: JSON.parse(chunk.request.tool_schema) as Record<
              string,
              unknown
            >,
          };
          inFlight++;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          const tCall = performance.now();
          try {
            input = await withRetry(() => extractChunk.mutateAsync(request));
            chunkCache.set(chunk.id, input);
          } catch {
            // Exhausted retries — skip this chunk (its recipes are lost, the rest
            // of the book proceeds), matching the native extractor.
            failed++;
            input = { recipes: [] };
          } finally {
            latencies.push(performance.now() - tCall);
            inFlight--;
          }
        }
        results.push({ id: chunk.id, input });
        done++;
        setExtract(source, {
          status: "extracting",
          done,
          total: chunks.length,
        });
        reassemble(false); // stream this chunk's recipes into the preview
      });

      reassemble(true); // authoritative final assemble + mark ready

      // --- profiling summary ---
      // Flush any pending longtask entries, then stop observing.
      observer?.takeRecords?.().forEach((e) => {
        longTasks++;
        longTaskMs += e.duration;
        if (e.duration > maxLongTaskMs) maxLongTaskMs = e.duration;
      });
      observer?.disconnect();
      const wallMs = performance.now() - tBook;
      const sorted = [...latencies].sort((a, b) => a - b);
      const totalCallMs = latencies.reduce((a, b) => a + b, 0);
      const pct = (p: number) =>
        Math.round(
          sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ??
            0,
        );
      const sumSizes = chunkSizes.reduce((a, b) => a + b, 0);
      console.info(`[cookbook-profile] ${deriveBookName(source)}`, {
        chunks: chunks.length,
        networkCalls: latencies.length,
        cacheHits: chunks.length - latencies.length,
        wallS: +(wallMs / 1000).toFixed(1),
        chunkEpubMs: Math.round(chunkEpubMs),
        assembleMsTotal: Math.round(assembleMs),
        avgChunkChars: Math.round(sumSizes / chunks.length),
        callLatencyMs: {
          p50: pct(0.5),
          p95: pct(0.95),
          max: Math.round(sorted.at(-1) ?? 0),
          avg: Math.round(totalCallMs / (latencies.length || 1)),
        },
        // CHUNK_CONCURRENCY is the cap; effective is what we actually got
        // (total call time ÷ wall time). Lower than the cap ⇒ throttled by the
        // browser's HTTP/1.1 conn limit (dev) or the gateway's rate limit.
        concurrencyCap: CHUNK_CONCURRENCY,
        maxInFlight,
        // Freezes: main-thread blocks >50ms during extraction. count high or
        // maxMs large ⇒ the UI janked (re-render / parse cost).
        freezes: {
          count: longTasks,
          totalMs: Math.round(longTaskMs),
          maxMs: Math.round(maxLongTaskMs),
        },
        effectiveConcurrency:
          wallMs > 0 ? +(totalCallMs / wallMs).toFixed(1) : 0,
      });
    },
    [extractChunk, setExtract, updateBook],
  );

  // Add dropped/picked .epub files as books and start extracting each.
  const addEpubFiles = useCallback(
    async (files: File[]) => {
      const epubs = files.filter((f) => /\.epub$/i.test(f.name));
      if (epubs.length === 0) {
        toast.error("Drop one or more .epub files");
        return;
      }
      const newBooks: Book[] = epubs
        // Skip a file already loaded (same name) so a re-drop doesn't duplicate.
        .filter((f) => !books.some((b) => b.source === f.name))
        .map((f) => ({
          source: f.name,
          name: deriveBookName(f.name),
          recipes: [],
          selected: new Set<number>(),
          results: new Map<number, ImportResult>(),
          extract: { status: "pending" },
          expanded: true,
        }));
      if (newBooks.length === 0) return;
      setBooks((prev) => [...prev, ...newBooks]);

      // Extract sequentially across books to keep the gateway load bounded
      // (chunks within a book already run concurrently).
      for (const book of newBooks) {
        const file = epubs.find((f) => f.name === book.source);
        if (!file) continue;
        const bytes = new Uint8Array(await file.arrayBuffer());
        await extractBook(book.source, bytes);
      }
    },
    [books, extractBook],
  );

  // Power-user path: a flat ImportRecipe[] or a {book,recipes}[] bundle.
  const loadJson = useCallback(async (file: File) => {
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast.error("Could not parse JSON");
      return;
    }
    const parsed = cookbookBundleSchema.safeParse(data);
    if (!parsed.success || parsed.data.length === 0) {
      toast.error("Not a valid cookbook export");
      return;
    }
    // Group recipes by their per-recipe source (fixes the old one-book-name-for-
    // all bug): each distinct source becomes its own book.
    const bySource = new Map<string, ImportRecipe[]>();
    for (const r of parsed.data) {
      const key = r.source ?? "(unknown)";
      const list = bySource.get(key);
      if (list) list.push(r);
      else bySource.set(key, [r]);
    }
    const loaded: Book[] = [...bySource.entries()].map(([source, recipes]) => ({
      source,
      name: deriveBookName(source),
      recipes,
      selected: new Set(recipes.map((_, i) => i)),
      results: new Map<number, ImportResult>(),
      extract: { status: "ready" as const, failedChunks: 0 },
      expanded: true,
    }));
    setBooks((prev) => [
      ...prev,
      ...loaded.filter((l) => !prev.some((b) => b.source === l.source)),
    ]);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      void addEpubFiles([...e.dataTransfer.files]);
    },
    [addEpubFiles],
  );

  // Import one book's selected recipes. First create/refresh the Cookbook row
  // (stores the full raw extraction + OPF metadata, and is the FK target), then
  // import each recipe once, in topological order (a referenced recipe before the
  // recipe that references it) so cross-recipe references resolve within the book
  // on a single insert (insertCookbook upserts by (cookbookId, title)).
  const importBook = useCallback(
    async (source: string) => {
      const book = books.find((b) => b.source === source);
      if (!book) return;
      const bookName = book.name.trim();
      if (!bookName) {
        toast.error("Book name is required");
        return;
      }
      const indices = [...book.selected].sort((a, b) => a - b);
      if (indices.length === 0) return;
      // Import a referenced recipe before the recipe that references it, so the
      // reference resolves to a recipe link on its single insert — no orphaned
      // plain ingredient, no second pass.
      const orderedIndices = topoOrderSelected(book.recipes, indices);

      // Resolve the cookbook id. When re-opened from stored source the cookbook
      // already exists — use its id and skip upsert (don't rewrite rawJson/cover).
      // Otherwise persist the cookbook up-front: its raw JSON is the *full*
      // extraction (not just the selected recipes) so reprocess / add-from-source
      // work later, and the cover (best-effort) is uploaded + attached now.
      let cookbookId: string;
      if (book.cookbookId) {
        cookbookId = book.cookbookId;
      } else {
        let coverImageId: string | undefined;
        if (
          book.cover &&
          (ALLOWED_IMAGE_TYPES as readonly string[]).includes(book.cover.mime)
        ) {
          try {
            coverImageId = await uploadImageBytes(
              book.cover.bytes,
              book.cover.mime,
              `${bookName}-cover.${book.cover.mime.split("/")[1] ?? "jpg"}`,
            );
          } catch (error) {
            console.warn("cookbook cover upload failed", error);
          }
        }
        try {
          const cookbook = await upsertCookbook.mutateAsync({
            name: bookName,
            rawJson: book.recipes,
            author: book.epubMeta?.author ?? [],
            subjects: book.epubMeta?.subjects ?? [],
            sourceLabel: source,
            coverImageId,
          });
          cookbookId = cookbook.id;
        } catch (error) {
          toast.error(`Couldn't save cookbook: ${getErrorMessage(error)}`);
          return;
        }
      }

      const setResult = (i: number, result: ImportResult) =>
        updateBook(source, (b) => ({
          ...b,
          results: new Map(b.results).set(i, result),
        }));

      const succeeded = new Set<number>();
      for (const i of orderedIndices) {
        setResult(i, { status: "importing" });
        try {
          const { id } = await insertCookbook.mutateAsync({
            recipe: book.recipes[i],
            cookbookId,
            book: bookName,
          });
          setResult(i, { status: "done", id });
          succeeded.add(i);
        } catch (error) {
          setResult(i, { status: "error", message: getErrorMessage(error) });
        }
      }
      toast.success(`Imported ${succeeded.size} from ${bookName}`);
    },
    [books, insertCookbook, upsertCookbook, updateBook, uploadImageBytes],
  );

  // Stable ref so memoized RecipeCards don't re-render every streaming pass just
  // because the parent re-rendered (the rest of `handlers` can be inline).
  const toggleRecipe = useCallback(
    (source: string, i: number) =>
      updateBook(source, (b) => {
        const selected = new Set(b.selected);
        if (selected.has(i)) {
          // Deselect is single — a referenced recipe may be wanted on its own.
          selected.delete(i);
          return { ...b, selected };
        }
        // Select cascades: also check the recipes this one references
        // (transitively, in-book) so their cross-recipe links resolve on import.
        addWithReferences(b.recipes, selected, i);
        return { ...b, selected };
      }),
    [updateBook],
  );

  const handlers = {
    rename: (source: string, name: string) =>
      updateBook(source, (b) => ({ ...b, name })),
    toggleRecipe,
    toggleAll: (source: string) =>
      updateBook(source, (b) => ({
        ...b,
        selected:
          b.selected.size === b.recipes.length
            ? new Set<number>()
            : new Set(b.recipes.map((_, i) => i)),
      })),
    toggleExpanded: (source: string) =>
      updateBook(source, (b) => ({ ...b, expanded: !b.expanded })),
    remove: (source: string) =>
      setBooks((prev) => prev.filter((b) => b.source !== source)),
    import: importBook,
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-semibold text-xl">Import cookbook</h1>
        <p className="text-muted-foreground text-sm">
          Drag{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">.epub</code>{" "}
          cookbooks here — Cubby extracts the recipes with AI, then you review
          and import.
        </p>
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center gap-2 rounded border border-border border-dashed p-8 text-muted-foreground transition-colors",
          isDragging && "border-accent bg-accent/10 text-accent-foreground",
        )}
      >
        <Upload className="h-6 w-6" />
        <p className="text-sm">Drag .epub cookbooks here, or choose files.</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Label
            htmlFor={fileInputId}
            className="cursor-pointer rounded border border-border px-3 py-1.5 font-medium text-foreground text-sm hover:bg-muted"
          >
            Choose .epub files
          </Label>
          <Input
            id={fileInputId}
            type="file"
            accept=".epub,application/epub+zip"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void addEpubFiles([...e.target.files]);
              e.target.value = "";
            }}
          />
          <Label
            htmlFor={jsonInputId}
            className="cursor-pointer text-muted-foreground text-xs underline hover:text-foreground"
          >
            or import JSON
          </Label>
          <Input
            id={jsonInputId}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void loadJson(file);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {books.map((book) => (
        <BookGroupCard
          key={book.source}
          book={book}
          handlers={handlers}
          importing={insertCookbook.isPending}
        />
      ))}
    </div>
  );
}
