//! EPUB cookbook extraction (client-side pipeline; LLM call proxied via Cubby).
//!
//! The browser drives the loop: `chunk_epub` splits an uploaded .epub into text
//! chunks each carrying a ready-to-send LLM request; the orchestrator sends each
//! request to Cubby's `extractCookbookChunk` proxy (which holds the gateway key);
//! `assemble_recipes` folds the per-chunk model outputs back into recipes. All
//! recipe logic stays in Rust — TS only moves bytes.

use recipe_epub::{
    assemble_recipes as assemble_recipes_internal, build_chunk_request,
    chunk_epub as chunk_epub_internal, cover_image_ref as cover_image_ref_internal,
    epub_metadata as epub_metadata_internal, parse_recipes_payload,
    read_image as read_image_internal, Chunk as EpubChunk, EpubMeta, ImageRef, Link as EpubLink,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

use crate::to_js;

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
/// the orchestrator's session cache), provenance, and the ready-to-send request.
/// `assemble_recipes` consumes the same chunks back, paired with model output.
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

/// The model's output for one chunk: the `id` it answers, plus the raw forced-
/// tool `input` object (`{ recipes: [...] }`) the proxy returned.
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WChunkResult {
    pub id: String,
    /// The forced tool's `input` object as returned by the LLM proxy.
    #[tsify(type = "unknown")]
    pub input: serde_json::Value,
}

/// `WChunkResult[]` (`transparent`).
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(transparent)]
pub struct WChunkResults(pub Vec<WChunkResult>);

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

/// Phase 1: unzip the EPUB and split it into text chunks, each carrying its
/// ready-to-send LLM request. Pure — no network, no filesystem.
#[wasm_bindgen]
pub fn chunk_epub(bytes: &[u8]) -> Result<WCookbookChunks, String> {
    let chunks = chunk_epub_internal(bytes).map_err(|e| e.to_string())?;
    let out = chunks
        .into_iter()
        .map(|c| {
            let req = build_chunk_request(&c);
            // Stable id over the chunk text → the orchestrator's session-cache
            // key (don't re-pay an already-extracted chunk on a retry).
            let id = Sha256::digest(c.text.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            WCookbookChunk {
                id,
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
                    tool_schema: serde_json::to_string(&req.tool_schema)
                        .unwrap_or_else(|_| "{}".to_string()),
                },
            }
        })
        .collect();
    Ok(WCookbookChunks(out))
}

/// Phase 2: fold the per-chunk model outputs into final recipes and resolve
/// cross-recipe references. `chunks` is the same array `chunk_epub` returned;
/// `results` pairs each chunk `id` with the model's raw tool output. Returns
/// `CookbookRecipe[]` (validate with `cookbookRecipesSchema` on the TS side).
#[wasm_bindgen]
pub fn assemble_recipes(
    chunks: WCookbookChunks,
    results: WChunkResults,
    source: String,
) -> Result<JsValue, String> {
    let mut by_id: std::collections::HashMap<String, serde_json::Value> =
        results.0.into_iter().map(|r| (r.id, r.input)).collect();
    let mut per_chunk = Vec::with_capacity(chunks.0.len());
    let mut links: Vec<EpubLink> = Vec::new();
    for c in chunks.0 {
        let recipes = match by_id.remove(&c.id) {
            Some(input) => parse_recipes_payload(input).map_err(|e| e.to_string())?,
            None => Vec::new(),
        };
        let chunk_links: Vec<EpubLink> = c
            .links
            .into_iter()
            .map(|l| EpubLink {
                text: l.text,
                href: l.href,
            })
            .collect();
        links.extend(chunk_links.iter().cloned());
        // `assemble_recipes` takes the full `Chunk` so it can bind each recipe's
        // hero photo (`hero_for` uses `text` + `images`). We deliberately pass empty
        // `text`/`images`, leaving the resulting `CookbookRecipe.image` = None.
        //
        // TODO(hero-photos): wire EPUB hero photos to the UI. recipe-epub already
        // computes a per-recipe `ImageRef` (an in-archive path + MIME, not bytes).
        // To use it we'd need to: (1) carry `text` + the `(line, ImageRef)` images
        // back across this boundary (re-add `text`/`images` to `WCookbookChunk` +
        // `WImageRef`), (2) materialize the bytes from the still-in-memory EPUB and
        // upload/persist them (R2) into a real image URL, and (3) surface `image` in
        // the TS cookbook schema + import path. Cubby has no image-display wiring for
        // cookbook imports today, so this is deferred.
        let chunk = EpubChunk {
            title_hint: c.title_hint,
            text: String::new(),
            doc_path: c.doc_path,
            links: chunk_links,
            images: Vec::new(),
        };
        per_chunk.push((chunk, recipes));
    }
    let recipes = assemble_recipes_internal(per_chunk, links, &source);
    to_js(&recipes, "assembled recipes")
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
