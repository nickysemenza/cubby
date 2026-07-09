//! EPUB cookbook extraction (client-side pipeline; LLM call proxied via Cubby).
//!
//! Rust drives the loop: `chunk_epub` splits an uploaded .epub into text chunks
//! each carrying a ready-to-send LLM request; `extract_cookbook` then runs the
//! whole per-chunk loop (retry → model escalation → salvage → assemble, shared
//! with the native path via `recipe_epub::try_extract_chunk`), calling back into
//! JS only for the one authenticated network hop to Cubby's `extractCookbookChunk`
//! proxy. All recipe logic stays in Rust — TS only moves bytes + renders.

use futures::stream::{self, StreamExt};
use recipe_epub::{
    CallResult, Chunk as EpubChunk, EpubError, EpubMeta, ExtractedRecipe, ImageRef,
    Link as EpubLink, Usage, assemble_recipes as assemble_recipes_internal, build_chunk_request,
    chunk_epub as chunk_epub_internal, cover_image_ref as cover_image_ref_internal,
    epub_metadata as epub_metadata_internal, read_image as read_image_internal, try_extract_chunk,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::{from_js, to_js};

/// One LLM request for a cookbook chunk (mirrors `recipe_epub::ChunkRequest`).
/// Sent verbatim to Cubby's `extractCookbookChunk` proxy.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WChunkRequest {
    pub system: String,
    pub user: String,
    pub tool_name: String,
    /// JSON Schema for the forced tool's input, as a JSON **string** — serde
    /// would otherwise marshal a `serde_json::Value` object across the wasm
    /// boundary as a JS `Map` (breaks `JSON.stringify` + tRPC validation). The
    /// orchestrator `JSON.parse`s it once before sending.
    pub tool_schema: String,
}

/// An internal EPUB hyperlink (mirrors `recipe_epub::Link`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WCookbookLink {
    pub text: String,
    pub href: String,
}

/// A unit of cookbook text to extract: a stable `id` (sha256 of the text, for
/// byte-identical chunks), provenance, and the ready-to-send request.
/// `extract_cookbook` drives each chunk's extraction from this.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WCookbookChunk {
    pub id: String,
    pub doc_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub title_hint: Option<String>,
    pub links: Vec<WCookbookLink>,
    pub request: WChunkRequest,
}

/// `WCookbookChunk[]` (`transparent`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(transparent)]
pub struct WCookbookChunks(pub Vec<WCookbookChunk>);

/// Book-level EPUB metadata (mirrors `recipe_epub::EpubMeta`): the OPF title,
/// authors, and subject tags. Surfaced so the cookbook import can stamp a
/// `Cookbook` row's metadata without re-running the LLM.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WEpubMeta {
    pub title: String,
    pub authors: Vec<String>,
    pub subjects: Vec<String>,
}

impl From<EpubMeta> for WEpubMeta {
    fn from(m: EpubMeta) -> Self {
        Self {
            title: m.title,
            authors: m.authors,
            subjects: m.subjects,
        }
    }
}

/// Lowercase hex of the sha256 of `bytes`. Writes two nibbles per byte into a
/// pre-sized buffer — no `format!`-per-byte allocation, and no `core::fmt`
/// machinery pulled into the wasm binary.
fn hex_sha256(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// Phase 1: unzip the EPUB and split it into text chunks, each carrying its
/// ready-to-send LLM request. Pure — no network, no filesystem.
#[wasm_bindgen]
pub fn chunk_epub(bytes: &[u8]) -> Result<WCookbookChunks, String> {
    let chunks = chunk_epub_internal(bytes).map_err(|e| e.to_string())?;
    let out = chunks
        .into_iter()
        .map(|c| -> Result<WCookbookChunk, String> {
            let req = build_chunk_request(&c);
            Ok(WCookbookChunk {
                // Stable id over the chunk text (dedups byte-identical chunks —
                // shared front-matter, a duplicated page).
                id: hex_sha256(c.text.as_bytes()),
                doc_path: c.doc_path,
                title_hint: c.title_hint,
                links: c
                    .links
                    .into_iter()
                    .map(|l| WCookbookLink {
                        text: l.text,
                        href: l.href,
                    })
                    .collect(),
                request: WChunkRequest {
                    system: req.system,
                    user: req.user,
                    tool_name: req.tool_name,
                    // Propagate (don't swallow) a serialization failure: a silent
                    // "{}" fallback would ship a permissive empty schema and quietly
                    // degrade extraction instead of surfacing the bug.
                    tool_schema: serde_json::to_string(&req.tool_schema)
                        .map_err(|e| format!("serialize tool_schema: {e}"))?,
                },
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(WCookbookChunks(out))
}

/// Drive ONE chunk to completion in the browser: call the proxy for the default
/// model (with the shared parse-retry policy), escalate to the stronger model on
/// failure, then salvage (empty) if even that won't parse. The decision logic is
/// the pure, native-shared [`try_extract_chunk`] — only the call primitive (a JS
/// proxy callback returning a Promise) is wasm-specific.
/// Returns the chunk's recipes plus, when the chunk was *salvaged* (skipped after
/// both the default model and escalation failed to parse), the failure reason —
/// so the driver can report which chunks were lost, distinct from chunks that
/// legitimately held no recipes. `None` = success (or an empty-but-parseable chunk).
async fn drive_chunk_wasm(
    doc_path: &str,
    request: &JsValue,
    call_chunk: &js_sys::Function,
) -> (Vec<ExtractedRecipe>, Option<String>) {
    // One proxy round-trip for the given model tier. `escalate=false` is the
    // default model; `true` tells the server-owned proxy to use the stronger one.
    let call = |escalate: bool| {
        let request = request.clone();
        async move {
            let returned = call_chunk
                .call2(&JsValue::NULL, &request, &JsValue::from_bool(escalate))
                .map_err(|e| EpubError::Proxy(format!("proxy callback threw: {e:?}")))?;
            // `Promise::resolve` adopts the returned thenable (the callback is
            // async), so this works whether or not it's already a Promise.
            let input_js = JsFuture::from(js_sys::Promise::resolve(&returned))
                .await
                .map_err(|e| EpubError::Proxy(format!("proxy callback rejected: {e:?}")))?;
            let input: serde_json::Value =
                from_js(input_js, "chunk input").map_err(EpubError::Proxy)?;
            Ok(CallResult {
                input: Some(input),
                usage: Usage::default(),
                truncated: false,
            })
        }
    };

    match try_extract_chunk(doc_path, || call(false)).await {
        Ok(driven) => (driven.recipes, None),
        // Default model couldn't return parseable output after its retry —
        // escalate this one chunk to the stronger model, then salvage if even
        // that fails. The models' malformed-output failure sets are disjoint, so
        // escalation recovers the default's misses.
        Err(primary_err) => match try_extract_chunk(doc_path, || call(true)).await {
            Ok(driven) => {
                tracing::info!("chunk {doc_path} recovered by escalating to the fallback model");
                (driven.recipes, None)
            }
            Err(esc_err) => {
                let reason =
                    format!("unparseable on default ({primary_err}) and escalation ({esc_err})");
                tracing::warn!("chunk {doc_path} {reason}; skipping");
                (Vec::new(), Some(reason))
            }
        },
    }
}

/// One raw chunk completion as it comes off `extract_cookbook`'s
/// `buffer_unordered` stream: original index, doc path, the assembler payload,
/// and the salvage-failure reason (if any).
type ChunkCompletion = (
    usize,
    String,
    (EpubChunk, Vec<ExtractedRecipe>),
    Option<String>,
);

/// Split a (possibly out-of-order) sequence of chunk completions into the
/// assembler's per-chunk payload list and the UI's index-sorted failure report.
/// `T` is whatever payload rides along with a completion — in `extract_cookbook`,
/// the `(EpubChunk, Vec<ExtractedRecipe>)` pair the assembler needs; `failure` is
/// `Some(reason)` when a chunk was salvaged (unparseable on both models).
///
/// Pure and independent of the `js_sys::Function` callback / `buffer_unordered`
/// stream, so the index-tagging/failure-attribution/sort logic is unit-testable
/// without a WASM runtime (see the tests below). Payload order in the returned
/// `Vec` mirrors completion order — irrelevant to the assembler, since it rebinds
/// recipes to their chunks (see the `buffer_unordered` note in `extract_cookbook`)
/// — but failures are always returned sorted by original index for a stable UI
/// order regardless of completion order.
fn partition_chunk_completions<T>(
    completions: impl IntoIterator<Item = (usize, String, T, Option<String>)>,
) -> (Vec<T>, Vec<WFailedChunk>) {
    let mut successes = Vec::new();
    let mut failed = Vec::new();
    for (index, doc_path, payload, failure) in completions {
        successes.push(payload);
        if let Some(reason) = failure {
            failed.push(WFailedChunk {
                index,
                doc_path,
                reason,
            });
        }
    }
    failed.sort_by_key(|f| f.index);
    (successes, failed)
}

/// Extract every recipe from a chunked EPUB, driving the whole per-chunk loop in
/// Rust. For each chunk it calls `call_chunk` (the JS proxy that performs the one
/// authenticated network hop), applies the shared retry → escalate → salvage
/// policy via [`drive_chunk_wasm`], and assembles the results.
///
/// - `call_chunk(request, escalate)` → Promise of the model's `{ recipes }`
///   payload. `request` is a [`WChunkRequest`]; `escalate` asks the server-owned
///   proxy for the stronger model.
/// - `on_progress(done, total, recipes)` is invoked after each chunk for the live
///   preview + progress bar (`recipes` is the assembled-so-far `CookbookRecipe[]`).
///
/// Returns the final assembled `CookbookRecipe[]`. This replaces the former JS
/// orchestration loop, so the retry/escalation/salvage policy lives in ONE place
/// (shared with the native CLI/desktop path); the browser supplies only transport
/// (the callback) and rendering (progress).
#[wasm_bindgen]
pub async fn extract_cookbook(
    chunks: WCookbookChunks,
    source: String,
    concurrency: usize,
    call_chunk: js_sys::Function,
    on_progress: js_sys::Function,
) -> Result<JsValue, String> {
    let total = chunks.0.len();

    // Pre-build each chunk's assemble-side `EpubChunk` + its proxy request, and
    // collect the book-wide anchor links (the Layer-2 cross-recipe signal).
    let mut links: Vec<EpubLink> = Vec::new();
    let mut prepared: Vec<(String, EpubChunk, JsValue)> = Vec::with_capacity(total);
    for c in chunks.0 {
        let chunk_links: Vec<EpubLink> = c
            .links
            .into_iter()
            .map(|l| EpubLink {
                text: l.text,
                href: l.href,
            })
            .collect();
        links.extend(chunk_links.iter().cloned());
        let request = to_js(&c.request, "chunk request")?;
        let epub_chunk = EpubChunk {
            title_hint: c.title_hint,
            text: String::new(),
            doc_path: c.doc_path.clone(),
            links: chunk_links,
            images: Vec::new(),
        };
        prepared.push((c.doc_path, epub_chunk, request));
    }

    // Run chunks concurrently (bounded), streaming each completion into a live
    // preview. `buffer_unordered` yields results as they finish; order is
    // irrelevant since the assembler rebinds recipes to their chunks — so we tag
    // each chunk with its 0-based position up front to attribute a failure to a
    // specific chunk regardless of completion order.
    let call_chunk = &call_chunk;
    let mut stream = stream::iter(prepared.into_iter().enumerate().map(
        |(index, (doc_path, epub_chunk, request))| async move {
            let (recipes, failure) = drive_chunk_wasm(&doc_path, &request, call_chunk).await;
            (index, doc_path, epub_chunk, recipes, failure)
        },
    ))
    .buffer_unordered(concurrency.max(1));

    // Accumulate the raw per-chunk completions as they arrive (out of order — see
    // the `buffer_unordered` note above) and derive both the live-preview payload
    // and the final result from the same pure `partition_chunk_completions`
    // helper, so the index-tagging/failure-attribution/sort logic runs through one
    // code path (independently unit-tested) instead of being duplicated inline.
    let mut completions: Vec<ChunkCompletion> = Vec::with_capacity(total);
    let mut done = 0usize;
    while let Some((index, doc_path, chunk, recipes, failure)) = stream.next().await {
        completions.push((index, doc_path, (chunk, recipes), failure));
        done += 1;
        // Stream a live preview for every chunk but the last; the final assemble
        // below doubles as the last progress tick (no double assemble at the end).
        if done < total {
            let (partial_chunks, _) = partition_chunk_completions(completions.clone());
            let partial = assemble_recipes_internal(partial_chunks, links.clone(), &source);
            let recipes_js = to_js(&partial, "partial recipes")?;
            let _ = on_progress.call3(
                &JsValue::NULL,
                &JsValue::from_f64(done as f64),
                &JsValue::from_f64(total as f64),
                &recipes_js,
            );
        }
    }

    let (per_chunk, failed) = partition_chunk_completions(completions);
    let recipes = assemble_recipes_internal(per_chunk, links, &source);
    let recipes_js = to_js(&recipes, "assembled recipes")?;
    let _ = on_progress.call3(
        &JsValue::NULL,
        &JsValue::from_f64(total as f64),
        &JsValue::from_f64(total as f64),
        &recipes_js,
    );
    // Return recipes + the salvaged (failed) chunks so the UI can surface
    // "imported N, M chunks failed" AND list WHICH chunks were lost (index +
    // originating doc + reason) for a targeted retry. `skipped` is kept as the
    // aggregate count (== failed_chunks.len()) so existing callers reading a plain
    // number don't break. Sorted by index for a stable UI order (the concurrent
    // stream completes out of order; `partition_chunk_completions` sorts). A plain
    // serde struct (serialized via serde-wasm-bindgen) — `CookbookRecipe` isn't
    // Tsify, so the `.d.ts` types the `recipes` field `any`; `failed_chunks` is
    // Tsify, so it's typed.
    to_js(
        &ExtractResult {
            recipes: &recipes,
            skipped: failed.len(),
            failed_chunks: &failed,
        },
        "extract result",
    )
}

/// One chunk that failed extraction on both the default and escalation models and
/// was salvaged (its recipes discarded). Carries enough identity for the UI to
/// name the loss and offer a retry.
#[derive(Tsify, Serialize, Deserialize, Clone)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WFailedChunk {
    /// 0-based position in the original `chunks` array passed to `extract_cookbook`.
    pub index: usize,
    /// Originating spine-document path (e.g. `"OEBPS/text/ch01.xhtml"`).
    pub doc_path: String,
    /// Why the chunk was salvaged (both models returned unparseable output).
    pub reason: String,
}

/// The `{ recipes, skipped, failed_chunks }` object [`extract_cookbook`] returns.
#[derive(Serialize)]
struct ExtractResult<'a> {
    recipes: &'a [recipe_epub::CookbookRecipe],
    skipped: usize,
    failed_chunks: &'a [WFailedChunk],
}

/// Read book-level metadata (title / authors / subjects) from an EPUB's OPF.
/// Pure — opens the `.epub` in memory and parses only the OPF (no content
/// decompression, no network). `undefined` if the bytes aren't a readable EPUB.
/// The cookbook import calls this once to stamp the `Cookbook` row.
#[wasm_bindgen]
pub fn epub_metadata(bytes: &[u8]) -> Option<WEpubMeta> {
    epub_metadata_internal(bytes).map(WEpubMeta::from)
}

/// A reference to an image resource inside an EPUB (mirrors `recipe_epub::ImageRef`):
/// its in-archive path + MIME, not the bytes. Pair with `read_image` to materialize.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WImageRef {
    pub path: String,
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub alt: Option<String>,
}

impl From<ImageRef> for WImageRef {
    fn from(r: ImageRef) -> Self {
        Self {
            path: r.path,
            mime: r.mime,
            alt: r.alt,
        }
    }
}

/// The EPUB's cover image reference (in-archive path + MIME), or `undefined` if
/// the book declares no cover. Pure (parses the OPF + resource map in memory).
/// Pair with `read_image` to get the bytes.
#[wasm_bindgen]
pub fn cover_image_ref(bytes: &[u8]) -> Option<WImageRef> {
    cover_image_ref_internal(bytes).map(WImageRef::from)
}

/// Read one image resource's bytes from an EPUB by its in-archive `path` (e.g. a
/// cover's `path` from `cover_image_ref`). `undefined` if the path isn't in the
/// archive. The MIME is already known from the ref, so only the bytes cross the
/// boundary (returned as a `Uint8Array`).
#[wasm_bindgen]
pub fn read_image(bytes: &[u8], path: &str) -> Option<Vec<u8>> {
    read_image_internal(bytes, path).map(|(data, _mime)| data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The chunk id is the lowercase hex sha256 of the text. Pinned against a
    /// known vector so the id (used for byte-identical-chunk dedup) can't
    /// silently change.
    #[test]
    fn hex_sha256_matches_known_vector() {
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// `buffer_unordered` yields chunk completions in whatever order they
    /// finish, not original index order — this is the actual completion shape
    /// `extract_cookbook` streams into `partition_chunk_completions`. All-success
    /// case: successes carry every payload, no failures reported.
    #[test]
    fn partition_handles_out_of_order_completions_all_success() {
        let completions = vec![
            (2, "ch3.xhtml".to_string(), "recipes-2", None),
            (0, "ch1.xhtml".to_string(), "recipes-0", None),
            (1, "ch2.xhtml".to_string(), "recipes-1", None),
        ];
        let (successes, failed) = partition_chunk_completions(completions);
        assert_eq!(successes, vec!["recipes-2", "recipes-0", "recipes-1"]);
        assert!(failed.is_empty());
    }

    /// Every chunk salvaged (unparseable on both models): failures must come
    /// back sorted by original index — not completion order — with each
    /// failure's `doc_path`/`reason` attributed to the chunk that produced it.
    #[test]
    fn partition_all_fail_sorts_by_original_index_and_attributes_doc_path() {
        let completions = vec![
            (
                3,
                "ch4.xhtml".to_string(),
                "payload-3",
                Some("bad json".to_string()),
            ),
            (
                1,
                "ch2.xhtml".to_string(),
                "payload-1",
                Some("truncated".to_string()),
            ),
            (
                0,
                "ch1.xhtml".to_string(),
                "payload-0",
                Some("empty tool call".to_string()),
            ),
        ];
        let (successes, failed) = partition_chunk_completions(completions);
        assert_eq!(successes.len(), 3);
        let indices: Vec<usize> = failed.iter().map(|f| f.index).collect();
        assert_eq!(indices, vec![0, 1, 3]);
        assert_eq!(failed[0].doc_path, "ch1.xhtml");
        assert_eq!(failed[0].reason, "empty tool call");
        assert_eq!(failed[1].doc_path, "ch2.xhtml");
        assert_eq!(failed[1].reason, "truncated");
        assert_eq!(failed[2].doc_path, "ch4.xhtml");
        assert_eq!(failed[2].reason, "bad json");
    }

    /// Mixed success/failure arriving scrambled relative to index (a later
    /// chunk finishing first is exactly what `buffer_unordered` can produce):
    /// every payload is retained, and only the failed ones are attributed, in
    /// index order.
    #[test]
    fn partition_interleaved_success_and_failure_attributes_correctly() {
        let completions = vec![
            (4, "ch5.xhtml".to_string(), "payload-4", None),
            (
                1,
                "ch2.xhtml".to_string(),
                "payload-1",
                Some("escalation also failed".to_string()),
            ),
            (0, "ch1.xhtml".to_string(), "payload-0", None),
            (3, "ch4.xhtml".to_string(), "payload-3", None),
            (
                2,
                "ch3.xhtml".to_string(),
                "payload-2",
                Some("unparseable".to_string()),
            ),
        ];
        let (successes, failed) = partition_chunk_completions(completions);
        assert_eq!(successes.len(), 5);
        let indices: Vec<usize> = failed.iter().map(|f| f.index).collect();
        assert_eq!(indices, vec![1, 2]);
        assert_eq!(failed[0].doc_path, "ch2.xhtml");
        assert_eq!(failed[0].reason, "escalation also failed");
        assert_eq!(failed[1].doc_path, "ch3.xhtml");
        assert_eq!(failed[1].reason, "unparseable");
    }
}
