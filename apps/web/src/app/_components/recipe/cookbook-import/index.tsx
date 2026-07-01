import type { WChunkRequest, WCookbookChunk } from "@cubby/recipebridge";
import { cookbookBundleSchema } from "@cubby/schemas/cookbook";
import {
  ALLOWED_IMAGE_TYPES,
  type AllowedImageType,
} from "@cubby/schemas/image";
import {
  type ImportRecipe,
  importRecipesSchema,
} from "@cubby/schemas/import-recipe";
import { useMutation, useQuery } from "@tanstack/react-query";
import { sum } from "es-toolkit";
import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useBulkStream } from "~/app/_components/hooks/useBulkStream";
import { Row } from "~/components/layout/row";
import { Stack } from "~/components/layout/stack";
import { Description } from "~/components/ui/description";
import { getErrorMessage } from "~/lib/error-utils";
import { wasm } from "~/lib/wasm";
import { useTRPC, useTRPCClient } from "~/trpc/react";
import { BookGroupCard } from "./book-group-card";
import { CookbookDropzone } from "./cookbook-dropzone";
import { deriveBookName, withRetry } from "./import-helpers";
import { addWithReferences, topoOrderSelected } from "./import-order";
import type {
  Book,
  ChunkRequestInput,
  ExtractPhase,
  FailedChunk,
  ImportResult,
} from "./types";

// The `failed_chunks` array from `wasm.extract_cookbook` (WASM `WFailedChunk[]`),
// camelCased at the boundary (`doc_path` → `docPath`). `extract_cookbook` returns
// `any` (its `CookbookRecipe`s aren't Tsify), so we validate this shape here.
const failedChunksSchema = z.array(
  z
    .object({
      index: z.number().int().nonnegative(),
      doc_path: z.string(),
      reason: z.string(),
    })
    .transform(
      ({ doc_path, ...rest }): FailedChunk => ({ ...rest, docPath: doc_path }),
    ),
);

// Chunks per book extracted concurrently, passed to the Rust driver
// (`wasm.extract_cookbook`). Matches the native `recipe-epub` extractor's default
// (`Options.concurrency`). Books extract one at a time, so this is the ceiling on
// simultaneous gateway calls. (In dev over HTTP/1.1 the browser caps ~6 in-flight
// to one origin anyway; prod is HTTP/2 and multiplexes.)
const CHUNK_CONCURRENCY = 8;

// Min gap between live-preview re-renders during extraction. Each re-assemble
// re-renders the whole growing card list (re-parsing every ingredient line), so
// without this an 8-chunk burst would fire 8 heavy renders back-to-back.
const PREVIEW_THROTTLE_MS = 600;

/**
 * Import cookbooks by dragging `.epub` files straight into Cubby. Each book is
 * extracted in the browser: WASM (`recipebridge.chunk_epub`) splits the EPUB into
 * text chunks, then `recipebridge.extract_cookbook` DRIVES the whole per-chunk
 * loop in Rust (retry → model escalation → salvage → assemble, shared with the
 * native CLI/desktop path). This component supplies only transport (`callChunk` →
 * `recipe.extractCookbookChunk`, which holds the gateway key) and rendering (the
 * `onProgress` live preview). Reviewed recipes import in ONE streamed request via
 * `recipe.importCookbookStream` (server-side loop + a single batched recompute,
 * progress streamed back), upserting by (book, title). A flat/bundled JSON file is
 * still accepted as a power-user path.
 */
export function CookbookImport({
  loadCookbookId,
}: {
  /** When set, re-open this cookbook's stored extraction for selective re-import. */
  loadCookbookId?: string;
}) {
  const api = useTRPC();
  const client = useTRPCClient();
  const extractChunk = useMutation(
    api.recipe.extractCookbookChunk.mutationOptions(),
  );
  const upsertCookbook = useMutation(
    api.recipe.upsertCookbook.mutationOptions(),
  );
  // Per-recipe outcome streamed back from `importCookbookStream`, keyed by the
  // recipe's index in `book.recipes` so each card maps to its result. `start` is
  // referentially stable, so destructure it for the importBook callback's deps.
  const { start: startCookbookImport } = useBulkStream<
    | { index: number; ok: true; id: string }
    | { index: number; ok: false; error: string },
    { succeeded: number; failed: number }
  >();
  const uploadImageMut = useMutation(api.image.uploadImage.mutationOptions());

  const [books, setBooks] = useState<Book[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  // Raw EPUB bytes by source, cached so a book can re-run extraction (retry after
  // failed chunks) without re-dropping the file. Kept in a ref, not state — the
  // bytes are large and never drive a render. JSON / from-source books have no
  // entry (they can't fail chunks).
  const epubBytesRef = useRef<Map<string, Uint8Array>>(new Map());

  // Extraction (minutes of concurrent LLM calls) and import both live entirely in
  // this component's state — there's no server-side record to resume from. Warn
  // before an accidental tab close / navigation while either is in flight so those
  // minutes of work aren't silently lost. Removed the instant nothing is running.
  const busy = books.some(
    (b) =>
      b.extract.status === "pending" ||
      b.extract.status === "extracting" ||
      b.importProgress !== undefined,
  );
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy assignment: some browsers still gate the native prompt on a truthy
      // returnValue rather than preventDefault alone.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [busy]);

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
      { cookbookId: loadCookbookId ?? "" },
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
              extract: { status: "ready", failedChunks: [] },
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

  // Extract one EPUB end to end: chunk in WASM, then the Rust driver runs the LLM
  // per chunk through the proxy (concurrent, retried, escalated, salvaged), then
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

      setExtract(source, {
        status: "extracting",
        done: 0,
        total: chunks.length,
      });

      // The whole per-chunk loop — retry, model escalation, salvage, concurrency,
      // and incremental assembly — runs in Rust (`wasm.extract_cookbook`, shared
      // with the native CLI/desktop path). The browser supplies only TRANSPORT
      // (`callChunk`, the one authenticated network hop) and RENDERING
      // (`onProgress`, the live preview). See recipebridge `extract_cookbook`.

      // --- profiling: per-call latency + live concurrency (assembly is in WASM) ---
      const tBook = performance.now();
      const latencies: number[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
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

      // TRANSPORT: one authenticated proxy hop per call. Rust decides when to call
      // this (and whether to `escalate`); `withRetry` handles transport failures.
      const callChunk = (
        request: WChunkRequest,
        escalate: boolean,
      ): Promise<unknown> => {
        const input: ChunkRequestInput = {
          system: request.system,
          user: request.user,
          toolName: request.tool_name,
          // WASM emits the schema as a JSON string (a serde_json::Value would
          // cross as a JS Map); parse it back to a plain object.
          toolSchema: JSON.parse(request.tool_schema) as Record<
            string,
            unknown
          >,
          escalate,
        };
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        const tCall = performance.now();
        return withRetry(() => extractChunk.mutateAsync(input)).finally(() => {
          latencies.push(performance.now() - tCall);
          inFlight--;
        });
      };

      // RENDERING: the Rust driver calls this after each chunk with the
      // assembled-so-far recipes. Throttled so an 8-chunk burst collapses to one
      // re-render (each re-render re-parses every line). The final tick
      // (done === total) always renders.
      let lastPreviewAt = 0;
      const onProgress = (
        doneCount: number,
        total: number,
        rawRecipes: unknown,
      ) => {
        setExtract(source, { status: "extracting", done: doneCount, total });
        const now = performance.now();
        const final = doneCount >= total;
        if (!final && now - lastPreviewAt < PREVIEW_THROTTLE_MS) return;
        lastPreviewAt = now;
        try {
          const recipes = importRecipesSchema.parse(rawRecipes);
          updateBook(source, (b) => ({
            ...b,
            recipes,
            // Auto-select everything; the import button is gated on `ready`.
            selected: new Set(recipes.map((_, i) => i)),
          }));
        } catch {
          // A transient partial-parse mid-flight is fine; the authoritative
          // result is taken from the awaited return below.
        }
      };

      let recipes: ImportRecipe[];
      let failedChunks: FailedChunk[];
      try {
        const result = (await wasm.extract_cookbook(
          chunks,
          source,
          CHUNK_CONCURRENCY,
          callChunk,
          onProgress,
        )) as { recipes: unknown; skipped: number; failed_chunks?: unknown };
        recipes = importRecipesSchema.parse(result.recipes);
        // Prefer the per-chunk failure detail (index + doc + reason). Fall back to
        // anonymous entries synthesized from the aggregate `skipped` count if an
        // older WASM artifact predates `failed_chunks` — a stale build degrades to
        // "N chunk(s) failed" rather than crashing.
        failedChunks =
          failedChunksSchema.safeParse(result.failed_chunks).data ??
          Array.from({ length: result.skipped }, (_, index) => ({
            index,
            docPath: "",
            reason: "Chunk failed to extract",
          }));
      } catch (error) {
        observer?.disconnect();
        setExtract(source, {
          status: "error",
          message: getErrorMessage(error),
        });
        return;
      }

      updateBook(source, (b) => ({
        ...b,
        recipes,
        selected: new Set(recipes.map((_, i) => i)),
        extract: { status: "ready", failedChunks },
      }));
      if (recipes.length === 0) {
        toast.warning(`No recipes found in ${deriveBookName(source)}`);
      }

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
      const totalCallMs = sum(latencies);
      const pct = (p: number) =>
        Math.round(
          sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ??
            0,
        );
      const sumSizes = sum(chunkSizes);
      console.info(`[cookbook-profile] ${deriveBookName(source)}`, {
        chunks: chunks.length,
        // Includes retries + escalations now (Rust may call back >1× per chunk).
        networkCalls: latencies.length,
        chunksSkipped: failedChunks.length,
        wallS: +(wallMs / 1000).toFixed(1),
        chunkEpubMs: Math.round(chunkEpubMs),
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
        // Cache for a later retry (re-run extraction without re-dropping the file).
        epubBytesRef.current.set(book.source, bytes);
        await extractBook(book.source, bytes);
      }
    },
    [books, extractBook],
  );

  // Re-run extraction for one book from its cached EPUB bytes — the retry path for
  // failed chunks. Re-extracting the whole book is idempotent downstream (import
  // upserts by (cookbook, title)), so a retry that now parses the previously-failed
  // chunks simply adds the recovered recipes. No-op if the bytes weren't cached.
  const retryExtraction = useCallback(
    (source: string) => {
      const bytes = epubBytesRef.current.get(source);
      if (!bytes) {
        toast.error("Original file unavailable — re-drop the .epub to retry.");
        return;
      }
      setExtract(source, { status: "pending" });
      void extractBook(source, bytes);
    },
    [extractBook, setExtract],
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
      extract: { status: "ready" as const, failedChunks: [] },
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
  // send the selected recipes — in topological order (a referenced recipe before
  // the recipe that references it) — to `importCookbookStream` in one request, so
  // cross-recipe references resolve within the book as the server upserts them
  // (it processes in the received order; upserts by (cookbookId, title)).
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

      // Optimistically mark every selected recipe importing + seed the bar, so the
      // button disables and a card spinner shows the instant the request fires.
      for (const i of orderedIndices) setResult(i, { status: "importing" });
      updateBook(source, (b) => ({
        ...b,
        importProgress: { done: 0, total: orderedIndices.length },
      }));

      // One streamed request: send just the selected indices (topo-ordered); the
      // recipes are already persisted in the cookbook's rawJson by the upsert above,
      // so the server reads them by index, upserts in order, and does a single
      // batched recompute. Per-recipe results + overall progress stream back.
      await startCookbookImport(
        () =>
          client.recipe.importCookbookStream.mutate({
            cookbookId,
            indices: orderedIndices,
          }),
        {
          onItem: (item) =>
            setResult(
              item.index,
              item.ok
                ? { status: "done", id: item.id }
                : { status: "error", message: item.error },
            ),
          onProgress: (done, total) =>
            updateBook(source, (b) => ({
              ...b,
              importProgress: { done, total },
            })),
          onDone: () =>
            updateBook(source, (b) => ({ ...b, importProgress: undefined })),
          successToast: (r) => `Imported ${r.succeeded} from ${bookName}`,
        },
      );
    },
    [
      books,
      client,
      startCookbookImport,
      upsertCookbook,
      updateBook,
      uploadImageBytes,
    ],
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
    retryExtraction,
  };

  return (
    <Stack>
      <div>
        <h1 className="font-semibold text-xl">Import cookbook</h1>
        <Description>
          Drag <code className="rounded bg-muted px-1 py-1 text-xs">.epub</code>{" "}
          cookbooks here — Cubby extracts the recipes with AI, then you review
          and import.
        </Description>
      </div>

      {busy && (
        <Row
          align="center"
          gap="xs"
          className="border border-warning/40 bg-warning/5 p-2 text-warning text-xs"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Keep this page open — extraction and import run here, not in the
          background. Leaving now loses in-progress work.
        </Row>
      )}

      <CookbookDropzone
        isDragging={isDragging}
        onDragStateChange={setIsDragging}
        onDrop={onDrop}
        onEpubFiles={(files) => void addEpubFiles(files)}
        onJsonFile={(file) => void loadJson(file)}
      />

      {books.map((book) => (
        <BookGroupCard
          key={book.source}
          book={book}
          handlers={handlers}
          importing={book.importProgress !== undefined}
        />
      ))}
    </Stack>
  );
}
