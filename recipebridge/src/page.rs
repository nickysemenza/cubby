//! A captured browser page boiled down to what the server reads: its text,
//! links, images, canonical URL, raw JSON-LD blocks, and whether it asks for a
//! password. The Mac sends a trimmed DOM; this is the one place that walks it,
//! so improving extraction never needs a Mac release and re-reads stored pages.
//! Exact values (URLs, JSON-LD) are copied verbatim; meaning is the model's.

use scraper::{ElementRef, Html, Node, Selector};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use url::Url;
use wasm_bindgen::prelude::*;

const MAX_TEXT_BYTES: usize = 200 * 1024;
const MAX_LINKS: usize = 500;
const MAX_IMAGES: usize = 300;
const MAX_JSON_LD_BLOCKS: usize = 20;
const MAX_JSON_LD_BYTES: usize = 512 * 1024;
const MAX_VARIANT_MARKERS: usize = 50;

#[derive(Tsify, Serialize, Deserialize, Debug, PartialEq)]
#[tsify(into_wasm_abi)]
pub struct WPageLink {
    pub href: String,
    pub text: String,
}

#[derive(Tsify, Serialize, Deserialize, Debug, PartialEq)]
#[tsify(into_wasm_abi)]
pub struct WPageImage {
    pub src: String,
    pub alt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// A larger rendition the page names for this image, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high_resolution: Option<String>,
}

#[derive(Tsify, Serialize, Deserialize, Debug, PartialEq)]
#[tsify(into_wasm_abi)]
pub struct WCompactPage {
    pub title: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_url: Option<String>,
    pub links: Vec<WPageLink>,
    pub images: Vec<WPageImage>,
    /// Each `application/ld+json` block's text, unparsed and never clipped.
    pub json_ld: Vec<String>,
    /// Blocks left out (over the count or byte bound): a reader must treat the
    /// page's structured data as incomplete.
    pub json_ld_omitted: u32,
    pub has_password_input: bool,
    /// The variant a product page shows as chosen (selected option, checked
    /// swatch), by its `data-asin` or label.
    pub variant_markers: Vec<String>,
}

/// Every element matching a static selector; a selector that fails to parse
/// (a bug here, never page input) matches nothing rather than panicking.
fn select<'a>(document: &'a Html, css: &str) -> Vec<ElementRef<'a>> {
    Selector::parse(css)
        .map(|selector| document.select(&selector).collect())
        .unwrap_or_default()
}

fn collapse(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn resolve(base: Option<&Url>, raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.starts_with("javascript:") || raw.starts_with("data:") {
        return None;
    }
    let resolved = match base {
        Some(base) => base.join(raw).ok()?,
        None => Url::parse(raw).ok()?,
    };
    matches!(resolved.scheme(), "http" | "https").then(|| resolved.to_string())
}

/// Elements whose text a reader never sees.
fn is_hidden(element: &ElementRef) -> bool {
    let value = element.value();
    if matches!(
        value.name(),
        "script" | "style" | "noscript" | "template" | "svg" | "head"
    ) {
        return true;
    }
    if value.attr("hidden").is_some() || value.attr("aria-hidden") == Some("true") {
        return true;
    }
    value.attr("style").is_some_and(|style| {
        let compact: String = style.chars().filter(|c| !c.is_whitespace()).collect();
        compact.contains("display:none") || compact.contains("visibility:hidden")
    })
}

fn is_block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "section"
            | "article"
            | "header"
            | "footer"
            | "main"
            | "aside"
            | "nav"
            | "li"
            | "ul"
            | "ol"
            | "tr"
            | "table"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "br"
            | "dt"
            | "dd"
            | "form"
            | "fieldset"
            | "figure"
            | "figcaption"
            | "blockquote"
    )
}

fn push_text(element: ElementRef, out: &mut String) {
    if out.len() >= MAX_TEXT_BYTES || is_hidden(&element) {
        return;
    }
    let block = is_block(element.value().name());
    if block && !out.ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    for child in element.children() {
        match child.value() {
            Node::Text(text) => {
                let collapsed = collapse(text);
                if collapsed.is_empty() {
                    continue;
                }
                if !out.is_empty() && !out.ends_with('\n') && !out.ends_with(' ') {
                    out.push(' ');
                }
                out.push_str(&collapsed);
            }
            Node::Element(_) => {
                if let Some(child) = ElementRef::wrap(child) {
                    push_text(child, out);
                }
            }
            _ => {}
        }
        if out.len() >= MAX_TEXT_BYTES {
            break;
        }
    }
    if block && !out.ends_with('\n') {
        out.push('\n');
    }
}

fn truncate_utf8(value: &mut String, max: usize) {
    if value.len() <= max {
        return;
    }
    let mut cut = max;
    while !value.is_char_boundary(cut) {
        cut -= 1;
    }
    value.truncate(cut);
}

/// The largest rendition named by an image's zoom attributes or Amazon's
/// `data-a-dynamic-image` map (URL → [width, height]).
fn high_resolution(element: &ElementRef, base: Option<&Url>) -> Option<String> {
    let value = element.value();
    for attribute in [
        "data-a-hires",
        "data-old-hires",
        "data-hires",
        "data-zoom-image",
    ] {
        if let Some(found) = value.attr(attribute).and_then(|raw| resolve(base, raw)) {
            return Some(found);
        }
    }
    let dynamic = value.attr("data-a-dynamic-image")?;
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(dynamic).ok()?;
    map.iter()
        .max_by_key(|(_, size)| {
            size.as_array()
                .and_then(|dims| Some(dims.first()?.as_u64()? * dims.get(1)?.as_u64()?))
                .unwrap_or(0)
        })
        .and_then(|(raw, _)| resolve(base, raw))
}

fn image_source<'a>(element: &'a ElementRef<'a>) -> Option<&'a str> {
    let value = element.value();
    value
        .attr("src")
        .filter(|src| !src.trim().is_empty() && !src.starts_with("data:"))
        .or_else(|| value.attr("data-src"))
        .or_else(|| {
            value
                .attr("srcset")
                .and_then(|set| set.split(',').next())
                .and_then(|candidate| candidate.split_whitespace().next())
        })
}

#[wasm_bindgen]
pub fn compact_browser_page(html: &str, url: &str) -> WCompactPage {
    let document = Html::parse_document(html);
    let base = Url::parse(url).ok();
    let base = base.as_ref();

    let title = select(&document, "title")
        .into_iter()
        .next()
        .map(|title| collapse(&title.text().collect::<String>()))
        .unwrap_or_default();

    let mut text = String::new();
    if let Some(body) = select(&document, "body").into_iter().next() {
        push_text(body, &mut text);
    }
    truncate_utf8(&mut text, MAX_TEXT_BYTES);
    let text = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    let canonical_url = select(&document, r#"link[rel="canonical"]"#)
        .into_iter()
        .find_map(|link| {
            link.value()
                .attr("href")
                .and_then(|href| resolve(base, href))
        });

    let links = select(&document, "a[href]")
        .into_iter()
        .filter_map(|anchor| {
            let href = resolve(base, anchor.value().attr("href")?)?;
            let label = collapse(&anchor.text().collect::<String>());
            let text = if label.is_empty() {
                collapse(anchor.value().attr("aria-label").unwrap_or_default())
            } else {
                label
            };
            Some(WPageLink { href, text })
        })
        .take(MAX_LINKS)
        .collect();

    let images = select(&document, "img")
        .into_iter()
        .filter_map(|image| {
            let src = resolve(base, image_source(&image)?)?;
            let dimension = |name: &str| {
                image
                    .value()
                    .attr(name)
                    .and_then(|raw| raw.trim().parse().ok())
            };
            Some(WPageImage {
                alt: collapse(image.value().attr("alt").unwrap_or_default()),
                width: dimension("width"),
                height: dimension("height"),
                high_resolution: high_resolution(&image, base),
                src,
            })
        })
        .take(MAX_IMAGES)
        .collect();

    let mut json_ld = Vec::new();
    let mut json_ld_omitted = 0u32;
    for script in select(&document, r#"script[type="application/ld+json"]"#) {
        let raw = script.text().collect::<String>();
        if raw.trim().is_empty() {
            continue;
        }
        if raw.len() > MAX_JSON_LD_BYTES || json_ld.len() >= MAX_JSON_LD_BLOCKS {
            json_ld_omitted += 1;
        } else {
            json_ld.push(raw);
        }
    }

    let has_password_input = select(&document, r#"input[type="password" i]"#)
        .into_iter()
        .next()
        .is_some();

    let variant_markers = select(&document,
            r#"#variation_color_name .selection, #variation_size_name .selection, [data-asin][aria-checked="true"], select[name*="variation"] option[selected]"#,
        )
        .into_iter()
        .filter_map(|node| {
            let marker = node
                .value()
                .attr("data-asin")
                .map(str::to_owned)
                .unwrap_or_else(|| collapse(&node.text().collect::<String>()));
            (!marker.is_empty()).then_some(marker)
        })
        .take(MAX_VARIANT_MARKERS)
        .collect();

    WCompactPage {
        title,
        text,
        canonical_url,
        links,
        images,
        json_ld,
        json_ld_omitted,
        has_password_input,
        variant_markers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<!doctype html><html><head><title> Example  Seed Packet </title>
<link rel="canonical" href="/products/basil">
<script type="application/ld+json">{"@type":"Product","sku":"BS-1","gtin13":"0012345678905"}</script>
</head><body>
<nav>Home</nav>
<h1>Genovese basil</h1><p>Sweet basil,  1 g packet</p>
<div hidden>Hidden promo</div><div style="display: none">Also hidden</div>
<span aria-hidden="true">icon</span>
<a href="/orders/42">Order  42</a><a href="javascript:void(0)">nothing</a>
<a href="https://other.example.test/x" aria-label="Elsewhere"></a>
<img src="/img/basil.jpg" alt="Basil packet" width="400" height="300" data-a-dynamic-image='{"https://cdn.example.test/small.jpg":[100,100],"https://cdn.example.test/large.jpg":[1200,1200]}'>
<img src="data:image/gif;base64,AAAA" data-src="/img/lazy.jpg" alt="">
<select name="variation_size"><option>10 g</option><option selected>1 g</option></select>
<form><input type="PASSWORD" name="p"></form>
</body></html>"#;

    #[test]
    fn compacts_a_page_into_text_links_images_and_raw_json_ld() {
        let page = compact_browser_page(PAGE, "https://seeds.example.test/products/basil?x=1");
        assert_eq!(page.title, "Example Seed Packet");
        assert_eq!(
            page.text,
            "Home\nGenovese basil\nSweet basil, 1 g packet\nOrder 42 nothing 10 g 1 g"
        );
        assert_eq!(
            page.canonical_url.as_deref(),
            Some("https://seeds.example.test/products/basil")
        );
        assert_eq!(
            page.links,
            vec![
                WPageLink {
                    href: "https://seeds.example.test/orders/42".into(),
                    text: "Order 42".into()
                },
                WPageLink {
                    href: "https://other.example.test/x".into(),
                    text: "Elsewhere".into()
                },
            ]
        );
        assert_eq!(page.images.len(), 2);
        assert_eq!(
            page.images[0].src,
            "https://seeds.example.test/img/basil.jpg"
        );
        assert_eq!(page.images[0].width, Some(400));
        assert_eq!(
            page.images[0].high_resolution.as_deref(),
            Some("https://cdn.example.test/large.jpg")
        );
        assert_eq!(
            page.images[1].src,
            "https://seeds.example.test/img/lazy.jpg"
        );
        assert_eq!(
            page.json_ld,
            vec![r#"{"@type":"Product","sku":"BS-1","gtin13":"0012345678905"}"#.to_string()]
        );
        assert_eq!(page.json_ld_omitted, 0);
        assert!(page.has_password_input);
        assert_eq!(page.variant_markers, vec!["1 g".to_string()]);
    }

    #[test]
    fn keeps_text_within_its_byte_bound_on_a_char_boundary() {
        let body = "é".repeat(MAX_TEXT_BYTES);
        let page = compact_browser_page(
            &format!("<html><body><p>{body}</p></body></html>"),
            "https://a.example.test/",
        );
        assert!(page.text.len() <= MAX_TEXT_BYTES);
        assert!(page.text.chars().all(|c| c == 'é'));
    }
}
