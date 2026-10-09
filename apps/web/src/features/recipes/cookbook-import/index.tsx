import type {
  Book as WasmBook,
  ExtractOptions,
  Progress,
} from "@cubby/recipebridge/cookbook";
import {
  cookbookExtractionSchema,
  cookbookRunReportSchema,
} from "@cubby/schemas/cookbook";
import {
  cookbookShortcode,
  type ImageShortcode,
} from "@cubby/schemas/identifiers";
import {
  ALLOWED_IMAGE_TYPES,
  type AllowedImageType,
} from "@cubby/schemas/image";
import { cookbookBundleManifestSchema } from "@cubby/schemas/import-recipe";
import { encodeBase64 } from "@cubby/shared/base64";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useMutation, useQueries } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { imageUpload } from "~/integrations/tanstack-query/generated/image-upload.gen";
import {
  recipe,
  recipeStreams,
} from "~/integrations/tanstack-query/generated/recipe.gen";
import {
  addWithDependencies,
  flattenRecipes,
  topoOrder,
} from "~/lib/cookbook-graph";
import { getErrorMessage } from "~/lib/error-utils";
import {
  PresignedUploadError,
  putPresignedObject,
} from "~/lib/presigned-upload";
import { wasm } from "~/lib/wasm";
import { showErrorToast } from "~/ui/feedback/error-details";
import { useBulkStream } from "~/ui/hooks/useBulkStream";
import { Row } from "~/ui/layout/row";
import { Stack } from "~/ui/layout/stack";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/ui/primitives/alert-dialog";
import { Description } from "~/ui/primitives/description";

import { BookGroupCard } from "./book-group-card";
import { runTwoAtATime } from "./bundle";
import type { CookbookBundleWorker } from "./bundle-worker";
import { CookbookDropzone } from "./cookbook-dropzone";
import { loadCookbookWasm, type LoadCookbookWasm } from "./cookbook-wasm";
import { asStoredExtraction, toBookEstimate } from "./extraction-result";
import { createGatewaySend } from "./gateway-transport";
import { deriveBookName } from "./import-helpers";
import {
  discardBookPhotoResources,
  resetReextractedBook,
  shouldPreparePhoto,
} from "./photo-lifecycle";
import { heroPhoto, selectedPhotoItemIds } from "./photos";
import type { Book, ExtractPhase, ImportResult, PhotoResult } from "./types";

/**
 * The tunables one extraction runs with.
 *
 * An empty `ladder` means the crate's catalog default, which is where model
 * choice belongs: the browser has no business pinning a model list that the
 * crate and the CLI would then disagree about. `second_opinion` and
 * `whole_book_escalation` are the two quality passes that cost extra money
 * only when the run needs them, and the estimate panel prices them in before
 * the user commits.
 */
const extractOptions = (label: string): ExtractOptions => ({
  label,
  concurrency: 8,
  ladder: [],
  second_opinion: true,
  whole_book_escalation: true,
  max_output_tokens: 16000,
});

const isAllowedImageType = (value: string): value is AllowedImageType =>
  ALLOWED_IMAGE_TYPES.some((type) => type === value);

/**
 * A cookbook JSON file, in either shape that produces one.
 *
 * `food-cli cookbook extract --format json` and the run store write a bare
 * book tree; a full run result wraps that tree next to its report. Accepting
 * both means a file from either source can be dropped without the user having
 * to know which one they have.
 */
const cookbookJsonFile = z.union([
  z.object({
    cookbook: cookbookExtractionSchema,
    report: cookbookRunReportSchema.nullish(),
  }),
  cookbookExtractionSchema.transform((cookbook) => ({
    cookbook,
    report: null,
  })),
]);

export function CookbookImport({
  loadCookbookId,
  loadEpubModule = loadCookbookWasm,
}: {
  /** When set, re-open this cookbook's stored extraction for selective re-import. */
  loadCookbookId?: string;
  /** The lazily loaded EPUB package. */
  loadEpubModule?: LoadCookbookWasm;
}) {
  const upsertCookbook = useMutation(recipe.upsertCookbook.mutationOptions());
  const forwardGateway = useMutation(
    recipe.forwardGatewayRequest.mutationOptions(),
  );
  const attachCookbookRecipePhoto = useMutation(
    recipe.attachCookbookRecipePhoto.mutationOptions(),
  );
  // Per-recipe outcome streamed back from `importCookbookStream`, keyed by the
  // tree item id so each card maps to its result. `start` is referentially
  // stable, so destructure it for the importBook callback's deps.
  const { start: startCookbookImport } = useBulkStream<
    | { sourceRecipeId: string; ok: true; id: string; hasImage: boolean }
    | { sourceRecipeId: string; ok: false; error: string },
    { succeeded: number; failed: number }
  >();
  const uploadImageMut = useMutation(imageUpload.uploadImage.mutationOptions());

  const [books, setBooks] = useState<Book[]>([]);
  // The open `Book` handles, one per source. These own the decompressed EPUB
  // inside wasm memory, which is why they are freed explicitly rather than left
  // to the GC, and why they live in a ref: they never drive a render.
  const bookHandlesRef = useRef<Map<string, WasmBook>>(new Map());
  // Raw EPUB bytes by source, cached so a book can be re-opened (retry after a
  // failed run, or after a cancel, which the crate will not let the same handle
  // survive). JSON / from-source books have no entry.
  const epubBytesRef = useRef<Map<string, Uint8Array>>(new Map());
  // A recipe image path only has meaning inside its EPUB. Cache by path within
  // each loaded book so shared archive art is read once but never crosses books.
  const archiveImageBytesRef = useRef<Map<string, Map<string, Uint8Array>>>(
    new Map(),
  );
  const previewUrlsRef = useRef<Map<string, Map<string, string>>>(new Map());
  const coverUrlsRef = useRef<Map<string, string>>(new Map());
  const bundleWorkersRef = useRef(new Map<string, CookbookBundleWorker>());
  const bundleUploadsRef = useRef(new Map<string, AbortController>());
  // Opening waits on the lazily loaded EPUB module. Each open takes a fresh
  // generation; removal, unmount, or a newer open of the same source retires
  // it, so a late continuation creates no handle nobody would free.
  const openGenerationRef = useRef(0);
  const currentOpensRef = useRef(new Map<string, number>());
  const beginOpen = useCallback((source: string) => {
    const generation = ++openGenerationRef.current;
    currentOpensRef.current.set(source, generation);
    return () => currentOpensRef.current.get(source) === generation;
  }, []);

  // Extraction (minutes of concurrent LLM calls) and import both live entirely in
  // this component's state — there's no server-side record to resume from. Warn
  // before an accidental tab close / navigation while either is in flight so those
  // minutes of work aren't silently lost. Removed the instant nothing is running.
  const busy = books.some(
    (b) =>
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

  const discardBookResources = useCallback((source: string) => {
    currentOpensRef.current.delete(source);
    bundleUploadsRef.current.get(source)?.abort();
    bundleUploadsRef.current.delete(source);
    bundleWorkersRef.current.get(source)?.close();
    bundleWorkersRef.current.delete(source);
    bookHandlesRef.current.get(source)?.free();
    bookHandlesRef.current.delete(source);
    epubBytesRef.current.delete(source);
    const cover = coverUrlsRef.current.get(source);
    if (cover) URL.revokeObjectURL(cover);
    coverUrlsRef.current.delete(source);
    discardBookPhotoResources(
      archiveImageBytesRef.current,
      previewUrlsRef.current,
      source,
      URL.revokeObjectURL,
    );
  }, []);

  // Free every wasm handle and object URL when the page goes away. The handles
  // hold whole decompressed EPUBs; leaving them to the GC would keep tens of
  // megabytes of wasm memory alive for the rest of the session.
  useEffect(
    () => () => {
      currentOpensRef.current.clear();
      for (const abort of bundleUploadsRef.current.values()) abort.abort();
      for (const worker of bundleWorkersRef.current.values()) worker.close();
      for (const handle of bookHandlesRef.current.values()) handle.free();
      bookHandlesRef.current.clear();
      for (const previews of previewUrlsRef.current.values()) {
        previews.forEach((url) => URL.revokeObjectURL(url));
      }
      for (const url of coverUrlsRef.current.values()) URL.revokeObjectURL(url);
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
      signal?: AbortSignal,
    ): Promise<ImageShortcode> => {
      const init = await uploadImageMut.mutateAsync({
        filename,
        contentType: mime,
        size: bytes.byteLength,
        entityKind: "COOKBOOK",
      });
      // Copy into a fresh ArrayBuffer-backed buffer (a valid BodyInit, and sidesteps
      // the Uint8Array<ArrayBufferLike> vs ArrayBuffer lib-type mismatch).
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      try {
        await putPresignedObject(init.uploadUrl, buf, mime, { signal });
      } catch (error) {
        throw new Error(
          `Storage error (${error instanceof PresignedUploadError ? error.status : "unknown"})`,
          { cause: error },
        );
      }
      return init.imageId;
    },
    [uploadImageMut],
  );

  // "Add from source": re-open a cookbook's stored tree as a ready Book so the
  // user can selectively re-import (no EPUB, no LLM). The cookbookId marks it so
  // importBook skips upsertCookbook; the card flags already-imported recipes.
  const sourceQueries = loadCookbookId
    ? [recipe.getCookbookSource.queryOptions({ cookbookId: loadCookbookId })]
    : [];
  const [source] = useQueries({ queries: sourceQueries });
  const [seeded, setSeeded] = useState(false);
  // Opening an EPUB waits on this module; warming it on mount keeps a click
  // right after choosing a file (e.g. Retry photo) from racing the bind.
  useEffect(() => {
    // SILENT: opening a book loads it again and reports the failure there.
    loadEpubModule().catch(() => undefined);
  }, [loadEpubModule]);
  useEffect(() => {
    if (!source?.data || seeded) return;
    const { id, name, cookbook, report } = source.data;
    setBooks((prev) =>
      prev.some((b) => b.cookbookId === id)
        ? prev
        : [
            ...prev,
            {
              source: name,
              name,
              cookbookId: id,
              extraction: cookbook,
              report,
              bundleManifest: cookbookBundleManifestSchema.safeParse(
                cookbook.bundleManifest,
              ).data,
              selected: new Set<string>(),
              results: new Map<string, ImportResult>(),
              photos: new Map<string, PhotoResult>(),
              photoPreviewUrls: new Map<string, string>(),
              extract: { status: "ready" },
              expanded: true,
            },
          ],
    );
    setSeeded(true);
  }, [source?.data, seeded]);

  const setPhotoResult = useCallback(
    (source: string, id: string, result: PhotoResult) =>
      updateBook(source, (book) => ({
        ...book,
        photos: new Map(book.photos).set(id, result),
      })),
    [updateBook],
  );

  const clearBookPhotoPreviews = useCallback(
    (source: string) =>
      updateBook(source, (book) => ({
        ...book,
        photoPreviewUrls: new Map<string, string>(),
      })),
    [updateBook],
  );

  const setPhotoPreview = useCallback(
    (source: string, id: string, bytes: Uint8Array, mime: string) => {
      const byId = previewUrlsRef.current.get(source) ?? new Map();
      const previous = byId.get(id);
      if (previous) URL.revokeObjectURL(previous);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
      byId.set(id, url);
      previewUrlsRef.current.set(source, byId);
      updateBook(source, (book) => ({
        ...book,
        photoPreviewUrls: new Map(book.photoPreviewUrls).set(id, url),
      }));
    },
    [updateBook],
  );

  const discardPhotoPreview = useCallback(
    (source: string, id: string) => {
      const previews = previewUrlsRef.current.get(source);
      const url = previews?.get(id);
      if (url) URL.revokeObjectURL(url);
      previews?.delete(id);
      updateBook(source, (book) => {
        const photoPreviewUrls = new Map(book.photoPreviewUrls);
        photoPreviewUrls.delete(id);
        return { ...book, photoPreviewUrls };
      });
    },
    [updateBook],
  );

  /**
   * Open (or re-open) one EPUB: outline, cover, and a cost estimate — all of it
   * local, none of it billable. The book then waits in `opened` until the user
   * asks for an extraction.
   *
   * Re-opening is also how a cancelled or failed run is retried: the crate will
   * not extract a cancelled book twice, so the handle is replaced rather than
   * reused, which is why the raw bytes are kept around.
   */
  const openBook = useCallback(
    async (source: string, bytes: Uint8Array): Promise<WasmBook | null> => {
      const isCurrent = beginOpen(source);
      let handle: WasmBook;
      try {
        const cookbookWasm = await loadEpubModule();
        if (!isCurrent()) return null;
        bookHandlesRef.current.get(source)?.free();
        bookHandlesRef.current.delete(source);
        handle = cookbookWasm.open_book(bytes, source);
      } catch (error) {
        if (!isCurrent()) return null;
        setExtract(source, {
          status: "error",
          message: getErrorMessage(error),
        });
        return null;
      }
      bookHandlesRef.current.set(source, handle);
      epubBytesRef.current.set(source, bytes);

      const outline = handle.outline();
      const coverRef = handle.cover();
      let cover: Book["cover"];
      let coverPreviewUrl: string | undefined;
      if (coverRef) {
        const data = handle.read_image(coverRef.path);
        if (data) {
          // Copy out of the wasm-owned buffer into a stable Uint8Array.
          const copy = new Uint8Array(data);
          cover = { bytes: copy, mime: coverRef.mime };
          const previousUrl = coverUrlsRef.current.get(source);
          if (previousUrl) URL.revokeObjectURL(previousUrl);
          const buffer = new ArrayBuffer(copy.byteLength);
          new Uint8Array(buffer).set(copy);
          coverPreviewUrl = URL.createObjectURL(
            new Blob([buffer], { type: coverRef.mime }),
          );
          coverUrlsRef.current.set(source, coverPreviewUrl);
        }
      }

      let estimate: Book["estimate"];
      try {
        estimate = toBookEstimate(handle.estimate(extractOptions(source)));
      } catch (error) {
        // SILENT: an estimate is advisory; a book that cannot be priced can
        // still be extracted, and the run report will say what it actually cost.
        console.warn("cookbook estimate failed", error);
      }

      updateBook(source, (b) => ({
        ...b,
        name: outline.source.title.trim() || b.name,
        outline: {
          title: outline.source.title,
          authors: [...outline.source.authors],
          chapters: outline.chapters.length,
          navRecipeTitles: outline.nav_recipe_titles,
          lines: outline.lines,
        },
        meta: {
          author: [...outline.source.authors],
          subjects: [...outline.source.subjects],
          // The OPF names one identifier "unique" but that is usually a Calibre
          // UUID, so scan all of them for a valid ISBN.
          isbn:
            wasm.isbn_from_epub_identifiers(outline.source.identifiers) ?? null,
        },
        cover,
        coverPreviewUrl,
        estimate,
        hasArchiveBytes: true,
        extract: { status: "opened" },
      }));
      return handle;
    },
    [beginOpen, loadEpubModule, setExtract, updateBook],
  );

  /**
   * Run one book end to end. The whole per-chunk loop — concurrency, retries,
   * the model ladder, the second opinion, whole-book escalation, cross-check
   * and assembly — runs in Rust, shared with the CLI. The browser supplies
   * transport and rendering, nothing else.
   */
  const extractBook = useCallback(
    async (source: string) => {
      const handle = bookHandlesRef.current.get(source);
      if (!handle) {
        toast.error("Open the .epub again to extract it.");
        return;
      }
      setExtract(source, { status: "extracting", progress: null });

      // TRANSPORT: the Rust driver builds each gateway request and decides when
      // to send it; the browser only signs and forwards. See `gateway-transport`.
      const send = createGatewaySend((input) =>
        forwardGateway.mutateAsync(input),
      );

      const onProgress = (progress: Progress) => {
        // Copy out of the wasm-owned object before it lands in React state.
        setExtract(source, {
          status: "extracting",
          progress: {
            ...progress,
            eta: { ...progress.eta },
            active_models: [...progress.active_models],
          },
        });
      };

      let result;
      try {
        result = await handle.extract(extractOptions(source), send, onProgress);
      } catch (error) {
        const message = getErrorMessage(error);
        if (message === "cancelled") {
          // Nothing went wrong, and the crate refuses to extract a cancelled
          // book a second time — so hand back a fresh handle on the same bytes,
          // returning the card to its estimate with an Extract button.
          const bytes = epubBytesRef.current.get(source);
          if (bytes) await openBook(source, bytes);
          else setExtract(source, { status: "error", message: "Cancelled" });
          toast.message(`Cancelled ${deriveBookName(source)}`);
          return;
        }
        setExtract(source, { status: "error", message });
        return;
      }

      const { cookbook, report } = asStoredExtraction(result);
      discardBookPhotoResources(
        archiveImageBytesRef.current,
        previewUrlsRef.current,
        source,
        URL.revokeObjectURL,
      );
      const recipes = flattenRecipes(cookbook);
      updateBook(source, (b) => ({
        ...b,
        extraction: cookbook,
        report,
        selected: new Set(recipes.map((entry) => entry.recipe.id)),
        // Per-recipe import and photo state belongs to the tree it was produced
        // against; a re-extraction produces a different one.
        ...resetReextractedBook(!!b.cookbookId),
        extract: { status: "ready" },
      }));
      if (recipes.length === 0) {
        toast.warning(`No recipes found in ${deriveBookName(source)}`);
      }
    },
    [forwardGateway, openBook, setExtract, updateBook],
  );

  // Add dropped/picked .epub files as books and open each. Extraction is NOT
  // started here: it costs money, so it waits for an explicit Extract click.
  const addEpubFiles = useCallback(
    async (files: File[]) => {
      const epubs = files.filter((f) => /\.epub$/i.test(f.name));
      if (epubs.length === 0) {
        toast.error("Drop one or more .epub files");
        return;
      }
      const newBooks: Book[] = [];
      const toOpen: string[] = [];
      const bytesBySource = new Map<string, Uint8Array>();
      for (const file of epubs) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        bytesBySource.set(file.name, bytes);
        if (!books.some((book) => book.source === file.name)) {
          newBooks.push({
            source: file.name,
            name: deriveBookName(file.name),
            selected: new Set<string>(),
            results: new Map<string, ImportResult>(),
            photos: new Map<string, PhotoResult>(),
            photoPreviewUrls: new Map<string, string>(),
            extract: { status: "opening" },
            expanded: true,
          });
        }
        toOpen.push(file.name);
      }
      if (newBooks.length) setBooks((prev) => [...prev, ...newBooks]);
      for (const name of toOpen) {
        const bytes = bytesBySource.get(name);
        if (bytes) await openBook(name, bytes);
      }
    },
    [books, openBook],
  );

  // Re-open the book from its kept EPUB bytes and extract again — the retry path
  // for failed or flagged chunks. Re-extracting the whole book is idempotent
  // downstream (import upserts by (cookbook, name)), so a retry that now reads
  // the previously-failed chunks simply adds the recovered recipes.
  const retryExtraction = useCallback(
    async (source: string) => {
      const bytes = epubBytesRef.current.get(source);
      if (!bytes) {
        toast.error("Original file unavailable — re-drop the .epub to retry.");
        return;
      }
      if (await openBook(source, bytes)) await extractBook(source);
    },
    [extractBook, openBook],
  );

  const cancelExtraction = useCallback(
    (source: string) => {
      bookHandlesRef.current.get(source)?.cancel();
      bundleUploadsRef.current.get(source)?.abort();
      bundleWorkersRef.current.get(source)?.close();
      bundleWorkersRef.current.delete(source);
      updateBook(source, (book) => ({
        ...book,
        hasArchiveBytes: book.bundleManifest ? false : book.hasArchiveBytes,
      }));
    },
    [updateBook],
  );

  const loadBundle = useCallback(
    async (file: File, bindSource?: string) => {
      // A static import puts the `new Worker(new URL(...))` site in the SSR
      // graph, which emits the ~640 kB worker bundle into the Worker upload
      // where nothing can load it.
      if (import.meta.env.SSR)
        throw new Error("Cookbook bundles open only in the browser");
      let worker: CookbookBundleWorker | undefined;
      try {
        const { CookbookBundleWorker } = await import("./bundle-worker");
        worker = new CookbookBundleWorker();
        const metadata = await worker.open(file);
        const prior = bindSource
          ? books.find((book) => book.source === bindSource)
          : books.find(
              (book) =>
                book.extraction?.source.sha256 ===
                metadata.manifest.source_sha256,
            );
        if (
          bindSource &&
          (!prior ||
            prior.extraction?.source.sha256 !== metadata.manifest.source_sha256)
        )
          throw new Error(
            "This .cookbook belongs to a different source; choose the matching archive or add it as a separate book.",
          );
        const source =
          prior?.source ?? `bundle:${metadata.manifest.source_sha256}`;
        bundleWorkersRef.current.get(source)?.close();
        bundleWorkersRef.current.set(source, worker);
        const recipes = flattenRecipes(metadata.cookbook);
        setBooks((current) => {
          const existing = current.find((book) => book.source === source);
          const book: Book = {
            ...(existing ?? {
              source,
              name: metadata.cookbook.source.title || deriveBookName(file.name),
              selected: new Set(recipes.map((entry) => entry.recipe.id)),
              results: new Map(),
              photos: new Map(),
              photoPreviewUrls: new Map(),
              expanded: true,
            }),
            extraction: metadata.cookbook,
            report: metadata.report,
            bundleManifest: metadata.manifest,
            hasArchiveBytes: true,
            extract: { status: "ready" },
            needsCookbookUpsert:
              !existing?.cookbookId ||
              existing.report?.run_id !== metadata.report.run_id,
          };
          return existing
            ? current.map((candidate) =>
                candidate.source === source ? book : candidate,
              )
            : [...current, book];
        });
        if (prior)
          toast.message(
            "Bundle ready; imported recipes and photos are preserved.",
          );
      } catch (error) {
        worker?.close();
        showErrorToast(error, "Could not open cookbook bundle");
      }
    },
    [books],
  );

  // Power-user path: a book tree exported by `food-cli cookbook extract`, or a
  // whole run result. No EPUB, so no photos and no re-extraction.
  const loadJson = useCallback(async (file: File) => {
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch (error) {
      showErrorToast(error, "Could not parse JSON");
      return;
    }
    const parsed = cookbookJsonFile.safeParse(data);
    if (!parsed.success) {
      toast.error("Not a valid cookbook extraction");
      return;
    }
    const { cookbook, report } = parsed.data;
    const source = cookbook.source.label || file.name;
    const recipes = flattenRecipes(cookbook);
    setBooks((prev) =>
      prev.some((b) => b.source === source)
        ? prev
        : [
            ...prev,
            {
              source,
              name: cookbook.source.title || deriveBookName(source),
              extraction: cookbook,
              report: report ?? null,
              meta: {
                author: cookbook.source.authors,
                subjects: cookbook.source.subjects,
                isbn:
                  wasm.isbn_from_epub_identifiers(
                    cookbook.source.identifiers,
                  ) ?? null,
              },
              selected: new Set(recipes.map((entry) => entry.recipe.id)),
              results: new Map<string, ImportResult>(),
              photos: new Map<string, PhotoResult>(),
              photoPreviewUrls: new Map<string, string>(),
              extract: { status: "ready" },
              expanded: true,
            },
          ],
    );
  }, []);

  const recipesOf = useCallback((book: Book) => {
    const entries = book.extraction ? flattenRecipes(book.extraction) : [];
    return new Map(entries.map((entry) => [entry.recipe.id, entry.recipe]));
  }, []);

  const getArchivePhotoBytes = useCallback(
    (book: Book, id: string): Uint8Array | null => {
      if (book.bundleManifest) return null;
      const photo = heroPhoto(recipesOf(book).get(id));
      if (!photo) return null;
      const handle = bookHandlesRef.current.get(book.source);
      if (!handle) {
        setPhotoResult(book.source, id, {
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
      let bytes = byPath.get(photo.path);
      if (!bytes) {
        try {
          const extracted = handle.read_image(photo.path);
          if (!extracted) {
            setPhotoResult(book.source, id, {
              status: "error",
              message: `The EPUB does not contain ${photo.path}.`,
            });
            return null;
          }
          bytes = new Uint8Array(extracted);
          byPath.set(photo.path, bytes);
        } catch (error) {
          setPhotoResult(book.source, id, {
            status: "error",
            message: getErrorMessage(error),
          });
          return null;
        }
      }
      return bytes;
    },
    [recipesOf, setPhotoResult],
  );

  const photoMime = useCallback(
    (book: Book, id: string): string => {
      const photo = heroPhoto(recipesOf(book).get(id));
      if (!photo) return "application/octet-stream";
      const handle = bookHandlesRef.current.get(book.source);
      return handle?.image_mime(photo.path) ?? photo.mime;
    },
    [recipesOf],
  );

  const prepareSelectedPhotos = useCallback(
    (book: Book, ids: readonly string[]) => {
      for (const id of selectedPhotoItemIds(recipesOf(book), ids)) {
        const bytes = getArchivePhotoBytes(book, id);
        if (!bytes) continue;
        setPhotoPreview(book.source, id, bytes, photoMime(book, id));
        // Reconnecting an EPUB must preserve a prior failure's Retry action,
        // and an attached result stays terminal even if selection changes.
        if (shouldPreparePhoto(book.photos.get(id))) {
          setPhotoResult(book.source, id, { status: "ready" });
        }
      }
    },
    [
      getArchivePhotoBytes,
      photoMime,
      recipesOf,
      setPhotoPreview,
      setPhotoResult,
    ],
  );

  useEffect(() => {
    for (const book of books) {
      if (!book.hasArchiveBytes || book.bundleManifest) continue;
      const unprepared = selectedPhotoItemIds(recipesOf(book), [
        ...book.selected,
      ]).filter((id) => shouldPreparePhoto(book.photos.get(id)));
      if (unprepared.length) prepareSelectedPhotos(book, unprepared);
    }
  }, [books, prepareSelectedPhotos, recipesOf]);

  // Re-attach the original EPUB to a book that was loaded from stored source or
  // JSON: the tree carries archive PATHS, and only the file has the bytes.
  const bindOriginalEpub = useCallback(
    async (source: string, file: File) => {
      if (/\.cookbook$/i.test(file.name)) {
        await loadBundle(file, source);
        return;
      }
      if (!/\.epub$/i.test(file.name)) {
        toast.error("Choose the original .epub file");
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isCurrent = beginOpen(source);
      let cookbookWasm: Awaited<ReturnType<LoadCookbookWasm>>;
      try {
        cookbookWasm = await loadEpubModule();
      } catch (error) {
        if (isCurrent()) showErrorToast(error, "Could not read that EPUB");
        return;
      }
      if (!isCurrent()) return;
      bookHandlesRef.current.get(source)?.free();
      bookHandlesRef.current.delete(source);
      discardBookPhotoResources(
        archiveImageBytesRef.current,
        previewUrlsRef.current,
        source,
        URL.revokeObjectURL,
      );
      clearBookPhotoPreviews(source);
      let handle: WasmBook;
      try {
        handle = cookbookWasm.open_book(bytes, source);
      } catch (error) {
        showErrorToast(error, "Could not read that EPUB");
        return;
      }
      bookHandlesRef.current.set(source, handle);
      epubBytesRef.current.set(source, bytes);
      updateBook(source, (book) => ({ ...book, hasArchiveBytes: true }));
      const book = books.find((candidate) => candidate.source === source);
      if (book) prepareSelectedPhotos(book, [...book.selected]);
      toast.message(`Original EPUB ready for ${file.name}`);
    },
    [
      beginOpen,
      books,
      clearBookPhotoPreviews,
      loadEpubModule,
      prepareSelectedPhotos,
      updateBook,
      loadBundle,
    ],
  );

  const attachPhoto = useCallback(
    async (book: Book, cookbookId: string, id: string, recipeId: string) => {
      if (book.bundleManifest) {
        const worker = bundleWorkersRef.current.get(book.source);
        const photo = heroPhoto(recipesOf(book).get(id));
        if (!worker || !photo) {
          setPhotoResult(book.source, id, {
            status: "missing-bytes",
            message: "Choose the original .cookbook file to add this photo.",
          });
          return;
        }
        setPhotoResult(book.source, id, { status: "pending" });
        try {
          const signal = bundleUploadsRef.current.get(book.source)?.signal;
          signal?.throwIfAborted();
          const bytes = await worker.readImage(photo.path);
          if (!isAllowedImageType(photo.mime))
            throw new Error(`Unsupported bundle image type: ${photo.mime}`);
          const uploadId = await uploadImageBytes(
            bytes,
            photo.mime,
            book.bundleManifest.images
              .find((asset) => asset.source_path === photo.path)
              ?.path.split("/")
              .at(-1) ?? "recipe-photo",
            signal,
          );
          signal?.throwIfAborted();
          const result = await attachCookbookRecipePhoto.mutateAsync({
            cookbookId,
            recipeId,
            sourceRecipeId: id,
            uploadId,
          });
          const photoUrl = result.photoUrl;
          if (photoUrl)
            updateBook(book.source, (current) => ({
              ...current,
              photoPreviewUrls: new Map(current.photoPreviewUrls).set(
                id,
                photoUrl,
              ),
            }));
          setPhotoResult(book.source, id, result);
        } catch (error) {
          setPhotoResult(book.source, id, {
            status: "error",
            message: getErrorMessage(error),
          });
        }
        return;
      }
      const bytes = getArchivePhotoBytes(book, id);
      if (!bytes) return;
      setPhotoPreview(book.source, id, bytes, photoMime(book, id));
      setPhotoResult(book.source, id, { status: "pending" });
      try {
        const result = await attachCookbookRecipePhoto.mutateAsync({
          cookbookId,
          recipeId,
          sourceRecipeId: id,
          data: encodeBase64(bytes),
        });
        setPhotoResult(book.source, id, result);
      } catch (error) {
        setPhotoResult(book.source, id, {
          status: "error",
          message: getErrorMessage(error),
        });
      }
    },
    [
      attachCookbookRecipePhoto,
      getArchivePhotoBytes,
      photoMime,
      setPhotoPreview,
      setPhotoResult,
      recipesOf,
      uploadImageBytes,
      updateBook,
    ],
  );

  const attachImportedPhotos = useCallback(
    async (
      book: Book,
      cookbookId: string,
      recipeIds: ReadonlyMap<string, { id: string; hasImage: boolean }>,
    ) => {
      const ids = selectedPhotoItemIds(recipesOf(book), [
        ...recipeIds.keys(),
      ]).filter((id) => !recipeIds.get(id)?.hasImage);
      if (ids.length === 0) return;
      updateBook(book.source, (current) => ({
        ...current,
        importProgress: undefined,
        photoProgress: { done: 0, total: ids.length },
      }));
      let done = 0;
      const process = async (id: string) => {
        const imported = recipeIds.get(id);
        if (imported) await attachPhoto(book, cookbookId, id, imported.id);
        done++;
        updateBook(book.source, (current) => ({
          ...current,
          photoProgress: { done, total: ids.length },
        }));
      };
      if (book.bundleManifest) await runTwoAtATime(ids, process);
      else for (const id of ids) await process(id);
      updateBook(book.source, (current) => ({
        ...current,
        photoProgress: undefined,
      }));
    },
    [attachPhoto, recipesOf, updateBook],
  );

  const retryPhoto = useCallback(
    async (source: string, id: string) => {
      const book = books.find((candidate) => candidate.source === source);
      const recipeResult = book?.results.get(id);
      if (!book?.cookbookId || recipeResult?.status !== "done") return;
      if (bundleUploadsRef.current.size) return;
      bundleUploadsRef.current.set(source, new AbortController());
      updateBook(source, (current) => ({
        ...current,
        photoProgress: { done: 0, total: 1 },
      }));
      try {
        await attachPhoto(book, book.cookbookId, id, recipeResult.id);
      } finally {
        bundleUploadsRef.current.delete(source);
        updateBook(source, (current) => ({
          ...current,
          photoProgress: undefined,
        }));
      }
    },
    [attachPhoto, books, updateBook],
  );

  const stageCover = useCallback(
    async (
      book: Book,
      extraction: NonNullable<Book["extraction"]>,
      bookName: string,
      controller: AbortController,
    ) => {
      const source = book.source;
      let coverUploadId: ImageShortcode | undefined;
      let coverFailed = false;
      if (
        book.bundleManifest &&
        extraction.cover &&
        isAllowedImageType(extraction.cover.mime)
      ) {
        const worker = bundleWorkersRef.current.get(source);
        if (worker) {
          try {
            const bytes = await worker.readImage(extraction.cover.path);
            coverUploadId = await uploadImageBytes(
              bytes,
              extraction.cover.mime,
              `${bookName}-cover`,
              controller.signal,
            );
          } catch (error) {
            coverFailed = true;
            showErrorToast(
              error,
              "Cover upload failed; retry the import to add it",
            );
          }
        } else coverFailed = true;
      }
      if (book.cover && isAllowedImageType(book.cover.mime)) {
        try {
          coverUploadId = await uploadImageBytes(
            book.cover.bytes,
            book.cover.mime,
            `${bookName}-cover.${book.cover.mime.split("/")[1] ?? "jpg"}`,
          );
        } catch (error) {
          coverFailed = true;
          showErrorToast(error, "Cover upload failed");
        }
      }
      return { coverUploadId, coverFailed };
    },
    [uploadImageBytes],
  );

  /**
   * Import one book's selected recipes.
   *
   * First persist the Cookbook row — it stores the WHOLE tree, not just the
   * selection, so "add from source" and reprocess work later, and it is the FK
   * target for everything that follows. Then stream the selected item ids in
   * dependency order, so a sub-recipe is committed before the recipe that
   * references it and the link resolves on the first insert.
   */
  const importBook = useCallback(
    async (source: string) => {
      const book = books.find((b) => b.source === source);
      if (!book?.extraction) return;
      const extraction = book.extraction;
      const bookName = book.name.trim();
      if (!bookName) {
        toast.error("Book name is required");
        return;
      }
      const orderedIds = topoOrder(extraction, [...book.selected]);
      if (orderedIds.length === 0) return;
      if (bundleUploadsRef.current.size) return;
      const controller = new AbortController();
      bundleUploadsRef.current.set(source, controller);
      updateBook(source, (current) => ({
        ...current,
        importProgress: { done: 0, total: orderedIds.length },
      }));
      try {
        // Resolve the cookbook id. When re-opened from stored source the cookbook
        // already exists — use its id and skip the upsert (don't rewrite the tree
        // or the cover). Otherwise persist it now, cover included (best-effort).
        let cookbookId: string;
        if (book.cookbookId && !book.needsCookbookUpsert) {
          cookbookId = book.cookbookId;
        } else {
          const { coverUploadId, coverFailed } = await stageCover(
            book,
            extraction,
            bookName,
            controller,
          );
          try {
            if (controller.signal.aborted) return;
            const cookbookInput: Parameters<
              typeof upsertCookbook.mutateAsync
            >[0] = {
              name: bookName,
              rawJson: extraction,
              report: book.report ?? null,
              author: extraction.source.authors,
              subjects: extraction.source.subjects,
              sourceLabel: source,
              coverUploadId,
              bundleManifest: book.bundleManifest,
              cookbookId: book.targetCookbookId
                ? cookbookShortcode.parse(book.targetCookbookId)
                : undefined,
            };
            // Transient — the server resolves it to a Product and stores only the
            // link. Omitted, not nulled, when the EPUB declares no ISBN.
            const isbn = wasm.isbn_from_epub_identifiers(
              extraction.source.identifiers,
            );
            if (isbn) cookbookInput.isbn = isbn;
            const cookbook = await upsertCookbook.mutateAsync(cookbookInput);
            cookbookId = cookbook.id;
            updateBook(source, (current) => ({
              ...current,
              cookbookId,
              name: cookbook.name ?? current.name,
              needsCookbookUpsert: coverFailed,
              cover: coverFailed ? current.cover : undefined,
            }));
          } catch (error) {
            showErrorToast(error, "Couldn't save cookbook");
            return;
          }
        }

        // Read selected archive images only after the cookbook identity is known,
        // but before recipe persistence so the review shows the exact photo queued
        // for each selected recipe. This is in-memory extraction, never an upload.
        prepareSelectedPhotos(book, orderedIds);

        const setResult = (id: string, result: ImportResult) =>
          updateBook(source, (b) => ({
            ...b,
            results: new Map(b.results).set(id, result),
          }));

        // Optimistically mark every selected recipe importing + seed the bar, so the
        // button disables and a card spinner shows the instant the request fires.
        for (const id of orderedIds) setResult(id, { status: "importing" });
        updateBook(source, (b) => ({
          ...b,
          importProgress: { done: 0, total: orderedIds.length },
        }));

        const persistedRecipeIds = new Map<
          string,
          { id: string; hasImage: boolean }
        >();
        await startCookbookImport(
          (signal) =>
            recipeStreams.importCookbookStream.open(
              { cookbookId, recipeIds: orderedIds },
              { signal: AbortSignal.any([signal, controller.signal]) },
            ),
          {
            onItem: (item) => {
              if (item.ok) {
                persistedRecipeIds.set(item.sourceRecipeId, {
                  id: item.id,
                  hasImage: item.hasImage,
                });
                if (item.hasImage) {
                  setPhotoResult(source, item.sourceRecipeId, {
                    status: "skipped-existing",
                  });
                }
              }
              setResult(
                item.sourceRecipeId,
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
            successToast: (r) => `Imported ${r.succeeded} from ${bookName}`,
          },
        );
        if (!controller.signal.aborted)
          await attachImportedPhotos(book, cookbookId, persistedRecipeIds);
      } finally {
        bundleUploadsRef.current.delete(source);
        updateBook(source, (current) => {
          const results = new Map(current.results);
          for (const [id, result] of results)
            if (result.status === "importing")
              results.set(id, {
                status: "error",
                message: controller.signal.aborted
                  ? "Import cancelled; saved recipes are preserved. Import again to continue."
                  : "Recipe import did not complete; import again to retry.",
              });
          return {
            ...current,
            importProgress: undefined,
            photoProgress: undefined,
            results,
          };
        });
      }
    },
    [
      attachImportedPhotos,
      books,
      prepareSelectedPhotos,
      setPhotoResult,
      startCookbookImport,
      updateBook,
      upsertCookbook,
      stageCover,
    ],
  );

  const toggleRecipe = useCallback(
    (source: string, id: string) => {
      const book = books.find((candidate) => candidate.source === source);
      if (!book?.extraction) return;
      const selected = new Set(book.selected);
      if (selected.has(id)) {
        selected.delete(id);
        discardPhotoPreview(source, id);
      } else {
        // Selecting cascades to the recipes this one uses as ingredients or is a
        // variation of, transitively, so their sub-recipe links resolve on import.
        addWithDependencies(book.extraction, selected, id);
        if (book.hasArchiveBytes) prepareSelectedPhotos(book, [...selected]);
      }
      updateBook(source, (current) => ({ ...current, selected }));
    },
    [books, discardPhotoPreview, prepareSelectedPhotos, updateBook],
  );

  const toggleAll = useCallback(
    (source: string) => {
      const book = books.find((candidate) => candidate.source === source);
      if (!book?.extraction) return;
      const all = flattenRecipes(book.extraction).map(
        (entry) => entry.recipe.id,
      );
      const selectingAll = book.selected.size !== all.length;
      const selected = selectingAll ? new Set(all) : new Set<string>();
      if (selectingAll && book.hasArchiveBytes) {
        prepareSelectedPhotos(book, [...selected]);
      }
      if (!selectingAll) {
        for (const id of book.photoPreviewUrls.keys()) {
          discardPhotoPreview(source, id);
        }
      }
      updateBook(source, (current) => ({ ...current, selected }));
    },
    [books, discardPhotoPreview, prepareSelectedPhotos, updateBook],
  );

  const handlers = {
    rename: (source: string, name: string) =>
      updateBook(source, (b) => ({ ...b, name })),
    target: (source: string, targetCookbookId: string) =>
      updateBook(source, (book) => ({
        ...book,
        targetCookbookId,
        needsCookbookUpsert: true,
      })),
    toggleRecipe,
    toggleAll,
    toggleExpanded: (source: string) =>
      updateBook(source, (b) => ({ ...b, expanded: !b.expanded })),
    remove: (source: string) => {
      discardBookResources(source);
      setBooks((prev) => prev.filter((b) => b.source !== source));
    },
    import: importBook,
    extract: (source: string) => void extractBook(source),
    cancel: cancelExtraction,
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
          cookbooks here to extract, or choose a .cookbook bundle that is
          already extracted. Review the recipes, then import.
        </Description>
      </div>

      {source?.isError && (
        <Row
          align="center"
          gap="xs"
          className="border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
        >
          <WarningIcon className="size-4 shrink-0" />
          {getErrorMessage(source.error)}
        </Row>
      )}

      {busy && (
        <Row
          align="center"
          gap="xs"
          className="border border-warning/40 bg-warning/5 p-2 text-xs text-warning-ink"
        >
          <WarningIcon className="size-4 shrink-0" />
          Keep this page open — extraction and import run here, not in the
          background. Leaving now loses in-progress work.
        </Row>
      )}

      <CookbookDropzone
        onEpubFiles={(files) => void addEpubFiles(files)}
        onJsonFile={(file) => void loadJson(file)}
        onBundleFile={(file) => void loadBundle(file)}
      />

      {books.map((book) => (
        <BookGroupCard
          key={book.source}
          book={book}
          handlers={handlers}
          importing={busy}
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
