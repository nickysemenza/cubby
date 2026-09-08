import type { WCookbookChunk } from "@cubby/recipebridge";
import { cookbookBundleSchema } from "@cubby/schemas/cookbook";
import {
  ALLOWED_IMAGE_TYPES,
  type AllowedImageType,
} from "@cubby/schemas/image";
import { type ImportRecipe } from "@cubby/schemas/import-recipe";
import { isbnFromEpubIdentifiers } from "@cubby/schemas/isbn";
import { useMutation, useQueries } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { sum } from "es-toolkit";
import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useBulkStream } from "~/app/_components/hooks/useBulkStream";
import { recipe, recipeStreams } from "~/app/recipes/recipe.functions";
import { Row } from "~/components/layout/row";
import { Stack } from "~/components/layout/stack";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Description } from "~/components/ui/description";
import { getErrorMessage } from "~/lib/error-utils";
import { imageUpload } from "~/lib/image.functions";
import { wasm } from "~/lib/wasm";

import { BookGroupCard } from "./book-group-card";
import { CookbookDropzone } from "./cookbook-dropzone";
import {
  extractCookbook,
  type ExtractionProgress,
  type ExtractionReport,
} from "./extraction";
import { deriveBookName } from "./import-helpers";
import { addWithReferences, topoOrderSelected } from "./import-order";
import {
  discardBookPhotoResources,
  resetReextractedBook,
  shouldPreparePhoto,
} from "./photo-lifecycle";
import { bytesToBase64, selectedArchivePhotoIndices } from "./photos";
import type {
  Book,
  ChunkRequestInput,
  ExtractPhase,
  ImportResult,
  PhotoResult,
} from "./types";

const CHUNK_CONCURRENCY = 8;

const isAllowedImageType = (value: string): value is AllowedImageType =>
  ALLOWED_IMAGE_TYPES.some((type) => type === value);

// Min gap between live-preview re-renders during extraction. Each re-assemble
// re-renders the whole growing card list (re-parsing every ingredient line), so
// without this an 8-chunk burst would fire 8 heavy renders back-to-back.
const PREVIEW_THROTTLE_MS = 600;

export function CookbookImport({
  loadCookbookId,
}: {
  /** When set, re-open this cookbook's stored extraction for selective re-import. */
  loadCookbookId?: string;
}) {
  const extractChunk = useMutation(
    recipe.extractCookbookChunk.mutationOptions(),
  );
  const upsertCookbook = useMutation(recipe.upsertCookbook.mutationOptions());
  const attachCookbookRecipePhoto = useMutation(
    recipe.attachCookbookRecipePhoto.mutationOptions(),
  );
  // Per-recipe outcome streamed back from `importCookbookStream`, keyed by the
  // recipe's index in `book.recipes` so each card maps to its result. `start` is
  // referentially stable, so destructure it for the importBook callback's deps.
  const { start: startCookbookImport } = useBulkStream<
    | { index: number; ok: true; id: string; hasImage: boolean }
    | { index: number; ok: false; error: string },
    { succeeded: number; failed: number }
  >();
  const uploadImageMut = useMutation(imageUpload.uploadImage.mutationOptions());

  const [books, setBooks] = useState<Book[]>([]);
  // Raw EPUB bytes by source, cached so a book can re-run extraction (retry after
  // failed chunks) without re-dropping the file. Kept in a ref, not state — the
  // bytes are large and never drive a render. JSON / from-source books have no
  // entry (they can't fail chunks).
  const epubBytesRef = useRef<Map<string, Uint8Array>>(new Map());
  // A recipe image path only has meaning inside its EPUB. Cache by path within
  // each loaded book so shared archive art is read once but never crosses books.
  const archiveImageBytesRef = useRef<Map<string, Map<string, Uint8Array>>>(
    new Map(),
  );
  const previewUrlsRef = useRef<Map<string, Map<number, string>>>(new Map());

  // Extraction (minutes of concurrent LLM calls) and import both live entirely in
  // this component's state — there's no server-side record to resume from. Warn
  // before an accidental tab close / navigation while either is in flight so those
  // minutes of work aren't silently lost. Removed the instant nothing is running.
  const busy = books.some(
    (b) =>
      b.extract.status === "pending" ||
      b.extract.status === "extracting" ||
      b.importProgress !== undefined ||
      b.photoProgress !== undefined,
  );
  // `beforeunload` alone only catches a tab close or reload — an in-app click on
  // the nav rail is a router navigation, which never fires it, and used to drop
  // the run silently. useBlocker covers both: it registers the beforeunload
  // handler itself via `enableBeforeUnload`, and `withResolver` hands back
  // proceed/reset so in-app navigation gets a real dialog instead of the
  // browser's unstyled prompt.
  const blocker = useBlocker({
    shouldBlockFn: () => busy,
    enableBeforeUnload: () => busy,
    withResolver: true,
  });

  const discardBookBytes = useCallback((source: string) => {
    epubBytesRef.current.delete(source);
    discardBookPhotoResources(
      archiveImageBytesRef.current,
      previewUrlsRef.current,
      source,
      URL.revokeObjectURL,
    );
  }, []);

  useEffect(
    () => () => {
      for (const previews of previewUrlsRef.current.values()) {
        previews.forEach((url) => URL.revokeObjectURL(url));
      }
    },
    [],
  );

  // Upload raw image bytes through the presigned-R2 flow (mirrors PendingImageUpload):
  // initiate → PUT to the presigned URL → return the new (PENDING) image id.
  const uploadImageBytes = useCallback(
    async (
      bytes: Uint8Array,
      mime: AllowedImageType,
      filename: string,
    ): Promise<string> => {
      const init = await uploadImageMut.mutateAsync({
        filename,
        contentType: mime,
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
  const sourceQueries = loadCookbookId
    ? [recipe.getCookbookSource.queryOptions({ cookbookId: loadCookbookId })]
    : [];
  const [source] = useQueries({ queries: sourceQueries });
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!source?.data || seeded) return;
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
              photos: new Map<number, PhotoResult>(),
              photoPreviewUrls: new Map<number, string>(),
              extract: { status: "ready", failedChunks: [] },
              expanded: true,
            },
          ],
    );
    setSeeded(true);
  }, [source?.data, seeded]);

  // Mutate one book in place by source key; always produces a new array so React
  // re-renders, and a new Set/Map where those change (no in-place mutation).
  const updateBook = useCallback((source: string, patch: (b: Book) => Book) => {
    setBooks((prev) => prev.map((b) => (b.source === source ? patch(b) : b)));
  }, []);

  const setPhotoResult = useCallback(
    (source: string, index: number, result: PhotoResult) =>
      updateBook(source, (book) => ({
        ...book,
        photos: new Map(book.photos).set(index, result),
      })),
    [updateBook],
  );

  const clearBookPhotoPreviews = useCallback(
    (source: string) =>
      updateBook(source, (book) => ({
        ...book,
        photoPreviewUrls: new Map<number, string>(),
      })),
    [updateBook],
  );

  const setPhotoPreview = useCallback(
    (source: string, index: number, bytes: Uint8Array, mime: string) => {
      const byIndex = previewUrlsRef.current.get(source) ?? new Map();
      const previous = byIndex.get(index);
      if (previous) URL.revokeObjectURL(previous);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
      byIndex.set(index, url);
      previewUrlsRef.current.set(source, byIndex);
      updateBook(source, (book) => ({
        ...book,
        photoPreviewUrls: new Map(book.photoPreviewUrls).set(index, url),
      }));
    },
    [updateBook],
  );

  const discardPhotoPreview = useCallback(
    (source: string, index: number) => {
      const previews = previewUrlsRef.current.get(source);
      const url = previews?.get(index);
      if (url) URL.revokeObjectURL(url);
      previews?.delete(index);
      updateBook(source, (book) => {
        const photoPreviewUrls = new Map(book.photoPreviewUrls);
        photoPreviewUrls.delete(index);
        return { ...book, photoPreviewUrls };
      });
    },
    [updateBook],
  );

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
              // The OPF names one identifier "unique" but that is usually a
              // Calibre UUID, so scan all of them for a valid ISBN.
              isbn: isbnFromEpubIdentifiers(meta.identifiers),
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
      // (`callChunk`, the authenticated network hop) and RENDERING
      // (`onProgress`, the live preview). See recipebridge `extract_cookbook`.

      const tBook = performance.now();
      const latencies: number[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const chunkSizes = chunks.map((c) => c.text.length);

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
      // this (and whether to `escalate`); the transport retains usage across retries.
      const callChunk = (input: ChunkRequestInput) => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        const tCall = performance.now();
        return extractChunk.mutateAsync(input).finally(() => {
          latencies.push(performance.now() - tCall);
          inFlight--;
        });
      };

      // RENDERING: the Rust driver calls this after each chunk with the
      // assembled-so-far recipes. Throttled so an 8-chunk burst collapses to one
      // re-render (each re-render re-parses every line). The final tick
      // (done === total) always renders.
      let lastPreviewAt = 0;
      const onProgress = ({
        done: doneCount,
        total,
        preview,
      }: ExtractionProgress) => {
        setExtract(source, { status: "extracting", done: doneCount, total });
        const now = performance.now();
        const final = doneCount >= total;
        if (!final && now - lastPreviewAt < PREVIEW_THROTTLE_MS) return;
        lastPreviewAt = now;
        if (!preview) return;
        updateBook(source, (b) => ({
          ...b,
          recipes: preview,
          selected: new Set(preview.map((_, i) => i)),
        }));
      };

      let report: ExtractionReport;
      try {
        report = await extractCookbook({
          chunks,
          source,
          concurrency: CHUNK_CONCURRENCY,
          callChunk,
          onProgress,
          onDiagnostic: (message) => toast.warning(message),
        });
      } catch (error) {
        observer?.disconnect();
        setExtract(source, {
          status: "error",
          message: getErrorMessage(error),
        });
        return;
      }

      const { recipes, failures: failedChunks } = report;
      discardBookPhotoResources(
        archiveImageBytesRef.current,
        previewUrlsRef.current,
        source,
        URL.revokeObjectURL,
      );
      updateBook(source, (b) => ({
        ...b,
        recipes,
        selected: new Set(recipes.map((_, i) => i)),
        // `results` and `importProgress` are keyed by recipe INDEX; extraction
        // repopulates `recipes` from scratch (fresh on the first run, a different
        // list on a re-extraction retry), so any prior per-index import state now
        // points at the wrong recipe — clear it.
        ...resetReextractedBook(!!b.cookbookId),
        // A local re-extraction changes index → recipe identity. Persist it
        // before the index-addressed import/photo operations can run again.
        needsCookbookUpsert: b.cookbookId ? true : b.needsCookbookUpsert,
        extract: { status: "ready", failedChunks, report },
      }));
      if (recipes.length === 0) {
        toast.warning(`No recipes found in ${deriveBookName(source)}`);
      }

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
      const newBooks: Book[] = [];
      const filesToExtract: Array<{ source: string; file: File }> = [];
      const rebinds: Array<{ source: string; file: File }> = [];
      for (const file of epubs) {
        const exact = books.find((book) => book.source === file.name);
        if (exact) {
          // A re-drop of an open book refreshes its transient bytes only; its
          // already-reviewed extraction remains authoritative.
          rebinds.push({ source: exact.source, file });
          continue;
        }
        const title = deriveBookName(file.name);
        const book: Book = {
          source: file.name,
          name: title,
          recipes: [],
          selected: new Set<number>(),
          results: new Map<number, ImportResult>(),
          photos: new Map<number, PhotoResult>(),
          photoPreviewUrls: new Map<number, string>(),
          extract: { status: "pending" },
          expanded: true,
        };
        newBooks.push(book);
        filesToExtract.push({ source: book.source, file });
      }
      if (newBooks.length) setBooks((prev) => [...prev, ...newBooks]);

      for (const { source, file } of rebinds) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        discardBookBytes(source);
        clearBookPhotoPreviews(source);
        epubBytesRef.current.set(source, bytes);
        updateBook(source, (book) => ({ ...book, hasArchiveBytes: true }));
        toast.message(`Reconnected ${file.name} for recipe photos`);
      }

      // Extract sequentially across books to keep the gateway load bounded
      // (chunks within a book already run concurrently).
      for (const { source, file } of filesToExtract) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // Cache for a later retry (re-run extraction without re-dropping the file).
        epubBytesRef.current.set(source, bytes);
        updateBook(source, (book) => ({ ...book, hasArchiveBytes: true }));
        await extractBook(source, bytes);
      }
    },
    [books, clearBookPhotoPreviews, discardBookBytes, extractBook, updateBook],
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
      photos: new Map<number, PhotoResult>(),
      photoPreviewUrls: new Map<number, string>(),
      extract: { status: "ready" as const, failedChunks: [] },
      expanded: true,
    }));
    setBooks((prev) => [
      ...prev,
      ...loaded.filter((l) => !prev.some((b) => b.source === l.source)),
    ]);
  }, []);

  const getArchivePhotoBytes = useCallback(
    (book: Book, index: number): Uint8Array | null => {
      const source = book.recipes[index]?.image;
      if (!source || source.kind !== "epub") return null;
      const epub = epubBytesRef.current.get(book.source);
      if (!epub) {
        setPhotoResult(book.source, index, {
          status: "missing-bytes",
          message: "Choose the original EPUB to add this photo.",
        });
        return null;
      }
      let byPath = archiveImageBytesRef.current.get(book.source);
      if (!byPath) {
        byPath = new Map();
        archiveImageBytesRef.current.set(book.source, byPath);
      }
      let bytes = byPath.get(source.path);
      if (!bytes) {
        try {
          const extracted = wasm.read_image(epub, source.path);
          if (!extracted) {
            setPhotoResult(book.source, index, {
              status: "error",
              message: `The EPUB does not contain ${source.path}.`,
            });
            return null;
          }
          bytes = new Uint8Array(extracted);
          byPath.set(source.path, bytes);
        } catch (error) {
          setPhotoResult(book.source, index, {
            status: "error",
            message: getErrorMessage(error),
          });
          return null;
        }
      }

      return bytes;
    },
    [setPhotoResult],
  );

  const prepareSelectedPhotos = useCallback(
    (book: Book, indices: readonly number[]) => {
      for (const index of selectedArchivePhotoIndices(book.recipes, indices)) {
        const source = book.recipes[index]?.image;
        const bytes = getArchivePhotoBytes(book, index);
        if (bytes && source?.kind === "epub") {
          setPhotoPreview(book.source, index, bytes, source.mime);
          // Reconnecting an EPUB must preserve a prior failure's Retry photo
          // action, and an attached result remains terminal even if selection
          // changes later in the review.
          if (shouldPreparePhoto(book.photos.get(index))) {
            setPhotoResult(book.source, index, { status: "ready" });
          }
        }
      }
    },
    [getArchivePhotoBytes, setPhotoPreview, setPhotoResult],
  );

  useEffect(() => {
    for (const book of books) {
      if (!book.hasArchiveBytes) continue;
      const unprepared = selectedArchivePhotoIndices(book.recipes, [
        ...book.selected,
      ]).filter((index) => shouldPreparePhoto(book.photos.get(index)));
      if (unprepared.length) prepareSelectedPhotos(book, unprepared);
    }
  }, [books, prepareSelectedPhotos]);

  const bindOriginalEpub = useCallback(
    async (source: string, file: File) => {
      if (!/\.epub$/i.test(file.name)) {
        toast.error("Choose the original .epub file");
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      discardBookBytes(source);
      clearBookPhotoPreviews(source);
      epubBytesRef.current.set(source, bytes);
      updateBook(source, (book) => ({ ...book, hasArchiveBytes: true }));
      const book = books.find((candidate) => candidate.source === source);
      if (book) prepareSelectedPhotos(book, [...book.selected]);
      toast.message(`Original EPUB ready for ${file.name}`);
    },
    [
      books,
      clearBookPhotoPreviews,
      discardBookBytes,
      prepareSelectedPhotos,
      updateBook,
    ],
  );

  const attachPhoto = useCallback(
    async (book: Book, cookbookId: string, index: number, recipeId: string) => {
      const source = book.recipes[index]?.image;
      if (!source || source.kind !== "epub") return;
      const bytes = getArchivePhotoBytes(book, index);
      if (!bytes) return;
      setPhotoPreview(book.source, index, bytes, source.mime);
      setPhotoResult(book.source, index, { status: "pending" });
      try {
        const result = await attachCookbookRecipePhoto.mutateAsync({
          cookbookId,
          recipeId,
          sourceIndex: index,
          data: bytesToBase64(bytes),
        });
        setPhotoResult(book.source, index, result);
      } catch (error) {
        setPhotoResult(book.source, index, {
          status: "error",
          message: getErrorMessage(error),
        });
      }
    },
    [
      attachCookbookRecipePhoto,
      getArchivePhotoBytes,
      setPhotoPreview,
      setPhotoResult,
    ],
  );

  const attachImportedPhotos = useCallback(
    async (
      book: Book,
      cookbookId: string,
      recipeIds: ReadonlyMap<number, { id: string; hasImage: boolean }>,
    ) => {
      const indices = selectedArchivePhotoIndices(book.recipes, [
        ...recipeIds.keys(),
      ]).filter((index) => !recipeIds.get(index)?.hasImage);
      if (indices.length === 0) return;
      updateBook(book.source, (current) => ({
        ...current,
        photoProgress: { done: 0, total: indices.length },
      }));
      let done = 0;
      for (const index of indices) {
        const recipe = recipeIds.get(index);
        if (recipe) await attachPhoto(book, cookbookId, index, recipe.id);
        done++;
        updateBook(book.source, (current) => ({
          ...current,
          photoProgress: { done, total: indices.length },
        }));
      }
      updateBook(book.source, (current) => ({
        ...current,
        photoProgress: undefined,
      }));
    },
    [attachPhoto, updateBook],
  );

  const retryPhoto = useCallback(
    async (source: string, index: number) => {
      const book = books.find((candidate) => candidate.source === source);
      const recipeResult = book?.results.get(index);
      if (!book?.cookbookId || recipeResult?.status !== "done") return;
      updateBook(source, (current) => ({
        ...current,
        photoProgress: { done: 0, total: 1 },
      }));
      try {
        await attachPhoto(book, book.cookbookId, index, recipeResult.id);
      } finally {
        updateBook(source, (current) => ({
          ...current,
          photoProgress: undefined,
        }));
      }
    },
    [attachPhoto, books, updateBook],
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
      if (book.cookbookId && !book.needsCookbookUpsert) {
        cookbookId = book.cookbookId;
      } else {
        let coverImageId: string | undefined;
        if (book.cover && isAllowedImageType(book.cover.mime)) {
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
          const cookbookInput: Parameters<
            typeof upsertCookbook.mutateAsync
          >[0] = {
            name: bookName,
            rawJson: book.recipes,
            author: book.epubMeta?.author ?? [],
            subjects: book.epubMeta?.subjects ?? [],
            sourceLabel: source,
            coverImageId,
            // Transient — the server resolves it to a Product and stores only
            // the link. Omitted, not nulled, when the EPUB declares no ISBN.
          };
          if (book.epubMeta?.isbn) cookbookInput.isbn = book.epubMeta.isbn;
          const cookbook = await upsertCookbook.mutateAsync(cookbookInput);
          cookbookId = cookbook.id;
          updateBook(source, (current) => ({
            ...current,
            cookbookId,
            needsCookbookUpsert: false,
            cover: undefined,
          }));
        } catch (error) {
          toast.error(`Couldn't save cookbook: ${getErrorMessage(error)}`);
          return;
        }
      }

      // Read selected archive images only after the cookbook identity is known,
      // but before recipe persistence so the review shows the exact photo queued
      // for each selected recipe. This is in-memory extraction, never an upload.
      prepareSelectedPhotos(book, orderedIndices);

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
      const persistedRecipeIds = new Map<
        number,
        { id: string; hasImage: boolean }
      >();
      await startCookbookImport(
        (signal) =>
          recipeStreams.importCookbookStream.open(
            { cookbookId, indices: orderedIndices },
            { signal },
          ),
        {
          onItem: (item) => {
            if (item.ok) {
              persistedRecipeIds.set(item.index, {
                id: item.id,
                hasImage: item.hasImage,
              });
              if (item.hasImage) {
                setPhotoResult(source, item.index, {
                  status: "skipped-existing",
                });
              }
            }
            setResult(
              item.index,
              item.ok
                ? { status: "done", id: item.id, hasImage: item.hasImage }
                : { status: "error", message: item.error },
            );
          },
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
      await attachImportedPhotos(book, cookbookId, persistedRecipeIds);
    },
    [
      attachImportedPhotos,
      books,
      prepareSelectedPhotos,
      setPhotoResult,
      startCookbookImport,
      updateBook,
      upsertCookbook,
      uploadImageBytes,
    ],
  );

  // Stable ref so memoized RecipeCards don't re-render every streaming pass just
  // because the parent re-rendered (the rest of `handlers` can be inline).
  const toggleRecipe = useCallback(
    (source: string, i: number) => {
      const book = books.find((candidate) => candidate.source === source);
      if (!book) return;
      const selected = new Set(book.selected);
      if (selected.has(i)) {
        selected.delete(i);
        discardPhotoPreview(source, i);
      } else {
        // Select cascades: also check the recipes this one references
        // (transitively, in-book) so their cross-recipe links resolve on import.
        addWithReferences(book.recipes, selected, i);
        if (book.hasArchiveBytes) {
          prepareSelectedPhotos(book, [...selected]);
        }
      }
      updateBook(source, (current) => ({ ...current, selected }));
    },
    [books, discardPhotoPreview, prepareSelectedPhotos, updateBook],
  );

  const toggleAll = useCallback(
    (source: string) => {
      const book = books.find((candidate) => candidate.source === source);
      if (!book) return;
      const selectingAll = book.selected.size !== book.recipes.length;
      const selected = selectingAll
        ? new Set(book.recipes.map((_, index) => index))
        : new Set<number>();
      if (selectingAll && book.hasArchiveBytes) {
        prepareSelectedPhotos(book, [...selected]);
      }
      if (!selectingAll) {
        for (const index of book.photoPreviewUrls.keys()) {
          discardPhotoPreview(source, index);
        }
      }
      updateBook(source, (current) => ({ ...current, selected }));
    },
    [books, discardPhotoPreview, prepareSelectedPhotos, updateBook],
  );

  const handlers = {
    rename: (source: string, name: string) =>
      updateBook(source, (b) => ({ ...b, name })),
    toggleRecipe,
    toggleAll,
    toggleExpanded: (source: string) =>
      updateBook(source, (b) => ({ ...b, expanded: !b.expanded })),
    remove: (source: string) => {
      discardBookBytes(source);
      setBooks((prev) => prev.filter((b) => b.source !== source));
    },
    import: importBook,
    retryExtraction,
    retryPhoto,
    bindOriginalEpub,
  };

  return (
    <Stack>
      <div>
        <h1 className="text-xl font-semibold">Import cookbook</h1>
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
          className="border border-warning/40 bg-warning/5 p-2 text-xs text-warning-ink"
        >
          <AlertTriangle className="size-4 shrink-0" />
          Keep this page open — extraction and import run here, not in the
          background. Leaving now loses in-progress work.
        </Row>
      )}

      <CookbookDropzone
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

      <AlertDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave and lose this run?</AlertDialogTitle>
            <AlertDialogDescription>
              Extraction and import run on this page, not in the background.
              Navigating away now discards the recipes extracted so far — there
              is no server-side record to resume from.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>
              Stay on this page
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => blocker.proceed?.()}>
              Leave and discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Stack>
  );
}
