//! Thin browser boundary for upstream EPUB extraction.
//!
//! `recipe_epub` owns chunking, bounded orchestration, retry and fallback policy,
//! stable ordering, previews, assembly, and reporting. Cubby supplies only the
//! authenticated JavaScript transport and serde/WASM conversion.

use recipe_epub::{
    CallFailure, CallResult, Chunk as EpubChunk, ChunkExtractionFailure, ChunkOutcome, EpubError,
    EpubMeta, ImageRef, ModelTier, OrchestrationOptions, Usage, build_chunk_request,
    chunk_epub as chunk_epub_internal, cover_image_ref as cover_image_ref_internal,
    epub_metadata as epub_metadata_internal, extract_chunks_with,
    read_image as read_image_internal, try_extract_chunk_detailed_for_chunk,
};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::{from_js, to_js};

#[derive(Debug, Clone, Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WChunkRequest {
    pub system: String,
    pub user: String,
    pub tool_name: String,
    /// JSON Schema as a string so the caller can parse it into ordinary JSON.
    pub tool_schema: String,
}

#[derive(Debug, Clone, Tsify, Serialize, Deserialize, PartialEq, Eq)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WCookbookLink {
    pub text: String,
    pub href: String,
}

/// An archive reference, never a public URL.
#[derive(Debug, Clone, Tsify, Serialize, Deserialize, PartialEq, Eq)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WImageRef {
    pub path: String,
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub alt: Option<String>,
}

impl From<ImageRef> for WImageRef {
    fn from(image: ImageRef) -> Self {
        Self {
            path: image.path,
            mime: image.mime,
            alt: image.alt,
        }
    }
}

impl From<WImageRef> for ImageRef {
    fn from(image: WImageRef) -> Self {
        Self {
            path: image.path,
            mime: image.mime,
            alt: image.alt,
        }
    }
}

#[derive(Debug, Clone, Tsify, Serialize, Deserialize, PartialEq, Eq)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WChunkImage {
    pub line_index: usize,
    pub image: WImageRef,
}

/// A complete upstream chunk.
#[derive(Debug, Clone, Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WCookbookChunk {
    pub doc_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub title_hint: Option<String>,
    pub text: String,
    pub links: Vec<WCookbookLink>,
    pub images: Vec<WChunkImage>,
}

impl WCookbookChunk {
    fn from_chunk(chunk: EpubChunk) -> Self {
        Self {
            doc_path: chunk.doc_path,
            title_hint: chunk.title_hint,
            text: chunk.text,
            links: chunk
                .links
                .into_iter()
                .map(|link| WCookbookLink {
                    text: link.text,
                    href: link.href,
                })
                .collect(),
            images: chunk
                .images
                .into_iter()
                .map(|(line_index, image)| WChunkImage {
                    line_index,
                    image: image.into(),
                })
                .collect(),
        }
    }

    fn into_chunk(self) -> EpubChunk {
        EpubChunk {
            title_hint: self.title_hint,
            text: self.text,
            doc_path: self.doc_path,
            links: self
                .links
                .into_iter()
                .map(|link| recipe_epub::Link {
                    text: link.text,
                    href: link.href,
                })
                .collect(),
            images: self
                .images
                .into_iter()
                .map(|image| (image.line_index, image.image.into()))
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(transparent)]
pub struct WCookbookChunks(pub Vec<WCookbookChunk>);

#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi)]
pub struct WEpubMeta {
    pub title: String,
    pub authors: Vec<String>,
    pub subjects: Vec<String>,
    pub identifiers: Vec<String>,
}

impl From<EpubMeta> for WEpubMeta {
    fn from(meta: EpubMeta) -> Self {
        Self {
            title: meta.title,
            authors: meta.authors,
            subjects: meta.subjects,
            identifiers: meta.identifiers,
        }
    }
}

#[derive(Deserialize)]
struct ProxyEnvelope {
    input: Option<serde_json::Value>,
    usage: Usage,
    truncated: bool,
    #[serde(default)]
    error: Option<ProxyError>,
}

#[derive(Deserialize)]
struct ProxyError {
    message: String,
    kind: ProxyErrorKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProxyErrorKind {
    Payload,
    Transport,
}

#[wasm_bindgen]
pub fn chunk_epub(bytes: &[u8]) -> Result<WCookbookChunks, String> {
    let chunks = chunk_epub_internal(bytes)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(WCookbookChunk::from_chunk)
        .collect();
    Ok(WCookbookChunks(chunks))
}

async fn call_proxy(
    request: &JsValue,
    fallback: bool,
    call_chunk: &js_sys::Function,
) -> Result<CallResult, CallFailure> {
    let returned = call_chunk
        .call2(&JsValue::NULL, request, &JsValue::from_bool(fallback))
        .map_err(|error| {
            CallFailure::transport(EpubError::Proxy(format!("proxy callback threw: {error:?}")))
        })?;
    let response = JsFuture::from(js_sys::Promise::resolve(&returned))
        .await
        .map_err(|error| {
            CallFailure::transport(EpubError::Proxy(format!(
                "proxy callback rejected: {error:?}"
            )))
        })?;
    let envelope: ProxyEnvelope = from_js(response, "chunk response")
        .map_err(|error| CallFailure::transport(EpubError::Proxy(error)))?;

    if let Some(error) = envelope.error {
        let epub_error = EpubError::Proxy(error.message);
        return Err(match error.kind {
            ProxyErrorKind::Payload => {
                CallFailure::retryable_payload(epub_error, envelope.usage, envelope.truncated)
            }
            ProxyErrorKind::Transport => {
                CallFailure::transport_with_metadata(epub_error, envelope.usage, envelope.truncated)
            }
        });
    }

    Ok(CallResult {
        input: envelope.input,
        usage: envelope.usage,
        truncated: envelope.truncated,
    })
}

/// Extract through upstream's shared driver. Both callback values are complete
/// upstream `ExtractionProgress` / `ExtractionReport` objects.
#[wasm_bindgen]
pub async fn extract_cookbook(
    chunks: WCookbookChunks,
    source: String,
    concurrency: usize,
    call_chunk: js_sys::Function,
    on_progress: js_sys::Function,
) -> Result<JsValue, String> {
    let chunks = chunks
        .0
        .into_iter()
        .map(WCookbookChunk::into_chunk)
        .collect();
    let options = OrchestrationOptions {
        concurrency,
        fallback: true,
        previews: true,
    };

    let report = extract_chunks_with(
        chunks,
        &source,
        &options,
        move |_index, chunk, tier| {
            let call_chunk = call_chunk.clone();
            async move {
                let request = build_chunk_request(&chunk);
                let tool_schema = serde_json::to_string(&request.tool_schema).map_err(|error| {
                    ChunkExtractionFailure::from(EpubError::Proxy(format!(
                        "serialize tool_schema: {error}"
                    )))
                })?;
                let request = to_js(
                    &WChunkRequest {
                        system: request.system,
                        user: request.user,
                        tool_name: request.tool_name,
                        tool_schema,
                    },
                    "chunk request",
                )
                .map_err(|error| ChunkExtractionFailure::from(EpubError::Proxy(error)))?;
                let fallback = matches!(tier, ModelTier::Fallback);
                let driven = try_extract_chunk_detailed_for_chunk(&chunk, || {
                    call_proxy(&request, fallback, &call_chunk)
                })
                .await?;
                Ok(ChunkOutcome {
                    recipes: driven.recipes,
                    usage: driven.usage,
                    cached: false,
                    truncated: driven.truncated,
                })
            }
        },
        move |progress| match to_js(&progress, "extraction progress") {
            Ok(progress) => {
                if let Err(error) = on_progress.call1(&JsValue::NULL, &progress) {
                    tracing::warn!("progress callback threw: {error:?}");
                }
            }
            Err(error) => tracing::warn!("could not serialize extraction progress: {error}"),
        },
    )
    .await;

    to_js(&report, "extraction report")
}

#[wasm_bindgen]
pub fn epub_metadata(bytes: &[u8]) -> Option<WEpubMeta> {
    epub_metadata_internal(bytes).map(WEpubMeta::from)
}

#[wasm_bindgen]
pub fn cover_image_ref(bytes: &[u8]) -> Option<WImageRef> {
    cover_image_ref_internal(bytes).map(WImageRef::from)
}

#[wasm_bindgen]
pub fn read_image(bytes: &[u8], path: &str) -> Option<Vec<u8>> {
    read_image_internal(bytes, path).map(|(data, _mime)| data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_chunk_metadata_survives_the_wasm_carrier() {
        let original = EpubChunk {
            title_hint: Some("Soup".to_string()),
            text: "Soup\nAn excellent soup.".to_string(),
            doc_path: "OEBPS/soup.xhtml".to_string(),
            links: vec![recipe_epub::Link {
                text: "Stock".to_string(),
                href: "stock.xhtml#recipe".to_string(),
            }],
            images: vec![(
                1,
                ImageRef {
                    path: "OEBPS/images/soup.jpg".to_string(),
                    mime: "image/jpeg".to_string(),
                    alt: Some("bowl of soup".to_string()),
                },
            )],
        };

        let carried = WCookbookChunk::from_chunk(original.clone());
        assert_eq!(carried.text, original.text);
        assert_eq!(carried.links[0].href, original.links[0].href);
        assert_eq!(carried.images[0].line_index, 1);
        assert_eq!(carried.images[0].image.path, original.images[0].1.path);
        assert_eq!(carried.into_chunk().images, original.images);
    }

    #[test]
    fn proxy_error_metadata_deserializes_without_loss() {
        let envelope: ProxyEnvelope = serde_json::from_value(serde_json::json!({
            "input": null,
            "usage": {
                "input_tokens": 11,
                "output_tokens": 7,
                "cache_creation_input_tokens": 3,
                "cache_read_input_tokens": 5
            },
            "truncated": true,
            "error": { "message": "invalid tool input", "kind": "payload" }
        }))
        .expect("envelope");

        assert_eq!(envelope.usage.input_tokens, 11);
        assert_eq!(envelope.usage.output_tokens, 7);
        assert_eq!(envelope.usage.cache_creation_input_tokens, 3);
        assert_eq!(envelope.usage.cache_read_input_tokens, 5);
        assert!(envelope.truncated);
        assert!(matches!(
            envelope.error.expect("error").kind,
            ProxyErrorKind::Payload
        ));
    }
}
