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

/// The one quoted string literal at the start of `source` (no escapes, so the
/// value is exactly what a reader sees) and what follows it.
fn string_literal(source: &str) -> Option<(&str, &str)> {
    let quote = source.chars().next().filter(|c| matches!(c, '\'' | '"'))?;
    let (value, rest) = source[1..].split_once(quote)?;
    (!value.contains('\\')).then_some((value, rest))
}

/// The target of an `onclick` that is exactly one navigation to a string
/// literal — `[window.|document.]location[.href] = '…'` or
/// `[window.|document.]location.assign|replace('…')`, with an optional
/// trailing `;`. Never evaluates script: any expression, variable, extra
/// statement, or escape rejects the handler; `resolve` then rejects non-HTTP
/// schemes.
fn literal_navigation(handler: &str) -> Option<&str> {
    let handler = handler.trim();
    let handler = handler.strip_suffix(';').unwrap_or(handler).trim_end();
    let handler = handler
        .strip_prefix("window.")
        .or_else(|| handler.strip_prefix("document."))
        .unwrap_or(handler);
    let rest = handler.strip_prefix("location")?;
    if let Some(call) = rest
        .strip_prefix(".assign")
        .or_else(|| rest.strip_prefix(".replace"))
    {
        let argument = call.trim_start().strip_prefix('(')?.trim_start();
        let (value, after) = string_literal(argument)?;
        return (after.trim() == ")").then_some(value);
    }
    let rest = rest.strip_prefix(".href").unwrap_or(rest);
    let value = rest.trim_start().strip_prefix('=')?.trim_start();
    let (value, after) = string_literal(value)?;
    after.trim().is_empty().then_some(value)
}

/// What a reader sees in an element, collapsed to one line.
fn visible_text(element: ElementRef) -> String {
    let mut out = String::new();
    push_text(element, &mut out);
    collapse(&out)
}

/// A clickable element's label. A table row reads as its first visible cell
/// (an order number, say), not every column run together.
fn link_label(element: ElementRef) -> String {
    let label = if element.value().name() == "tr" {
        element
            .children()
            .filter_map(ElementRef::wrap)
            .filter(|cell| matches!(cell.value().name(), "td" | "th"))
            .map(visible_text)
            .find(|text| !text.is_empty())
            .unwrap_or_default()
    } else {
        collapse(&element.text().collect::<String>())
    };
    if label.is_empty() {
        collapse(element.value().attr("aria-label").unwrap_or_default())
    } else {
        label
    }
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

    // Scripted pages navigate from `onclick` rows and buttons with no anchor
    // once the snapshot drops `<noscript>`; a literal target counts as a link.
    let links = select(&document, "a[href], [onclick]")
        .into_iter()
        .filter_map(|element| {
            let value = element.value();
            let href = value
                .attr("href")
                .filter(|_| value.name() == "a")
                .and_then(|href| resolve(base, href))
                .or_else(|| resolve(base, literal_navigation(value.attr("onclick")?)?))?;
            Some(WPageLink {
                href,
                text: link_label(element),
            })
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

    // Regression: an account history table navigates by row `onclick`, with no
    // anchor left once the snapshot strips `<noscript>`; the row's first cell
    // (the order number) labels it, not the whole row.
    #[test]
    fn keeps_literal_onclick_navigation_targets_labeled_by_first_cell() {
        let page = compact_browser_page(
            r#"<html><body><table><tbody>
<tr onclick="window.location.href = 'https://shop.example.test/account/orders/opaque-token'"><td><span>#54321</span></td><td>Jan 2, 2026</td></tr>
<tr onclick='location.href="/account/orders/second-token";'><td aria-hidden="true">x</td><td>#54322</td><td>Jan 3, 2026</td></tr>
</tbody></table>
<div role="button" onclick="document.location.assign('/account/orders/third-token')">View order</div>
<a href="javascript:void(0)" onclick="window.location.replace('/account/orders/fourth-token')" aria-label="Fourth order"></a>
</body></html>"#,
            "https://shop.example.test/account/orders",
        );
        assert_eq!(
            page.links,
            vec![
                WPageLink {
                    href: "https://shop.example.test/account/orders/opaque-token".into(),
                    text: "#54321".into()
                },
                WPageLink {
                    href: "https://shop.example.test/account/orders/second-token".into(),
                    text: "#54322".into()
                },
                WPageLink {
                    href: "https://shop.example.test/account/orders/third-token".into(),
                    text: "View order".into()
                },
                WPageLink {
                    href: "https://shop.example.test/account/orders/fourth-token".into(),
                    text: "Fourth order".into()
                },
            ]
        );
    }

    #[test]
    fn ignores_onclick_handlers_that_are_not_one_literal_navigation() {
        let rejected = [
            "window.location.href = '/orders/' + id",
            "window.location.href = base",
            "window.location.href = `/orders/${id}`",
            "window.location.href = '/a'; track()",
            "track(); window.location.href = '/a'",
            "window.location.href == '/a'",
            "window.location.href = '/a\\'b'",
            "window.location.href = 'javascript:alert(1)'",
            "window.location.href = 'JavaScript:alert(1)'",
            "window.location.href = 'data:text/html,x'",
            "window.location.href = 'mailto:a@example.test'",
            "window.location.href = '/a'.concat('b')",
            "window.location.assign('/a', '/b')",
            "window.open('/a')",
            "evil.location.href = '/a'",
            "x.href = '/a'",
            "window.location.href = ''",
        ];
        for handler in rejected {
            let page = compact_browser_page(
                &format!(
                    r#"<html><body><table><tr onclick="{}"><td>#1</td></tr></table></body></html>"#,
                    handler.replace('"', "&quot;")
                ),
                "https://shop.example.test/account/orders",
            );
            assert_eq!(page.links, vec![], "accepted {handler:?}");
        }
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
