//! HTML traversal shared by email text, links and image extraction.

use scraper::{ElementRef, Html, Node, Selector};
use url::Url;

const MAX_TEXT_BYTES: usize = 200 * 1024;

/// Every element matching a static selector; a selector that fails to parse
/// (a bug here, never page input) matches nothing rather than panicking.
pub(crate) fn select<'a>(document: &'a Html, css: &str) -> Vec<ElementRef<'a>> {
    Selector::parse(css)
        .map(|selector| document.select(&selector).collect())
        .unwrap_or_default()
}

pub(crate) fn collapse(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn resolve(base: Option<&Url>, raw: &str) -> Option<String> {
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

/// Visual and inert-content exclusions, independent of accessibility exposure.
pub(crate) fn is_visually_hidden(element: &ElementRef) -> bool {
    let value = element.value();
    if matches!(
        value.name(),
        "script" | "style" | "noscript" | "template" | "svg" | "head"
    ) {
        return true;
    }
    if value.attr("hidden").is_some() {
        return true;
    }
    value.attr("style").is_some_and(|style| {
        let compact: String = style.chars().filter(|c| !c.is_whitespace()).collect();
        compact.contains("display:none") || compact.contains("visibility:hidden")
    })
}

pub(crate) fn is_block(name: &str) -> bool {
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

fn push_text(element: ElementRef, out: &mut String, hidden: fn(&ElementRef) -> bool) {
    if out.len() >= MAX_TEXT_BYTES || hidden(&element) {
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
                    push_text(child, out, hidden);
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

pub(crate) fn truncate_utf8(value: &mut String, max: usize) {
    if value.len() <= max {
        return;
    }
    let mut cut = max;
    while !value.is_char_boundary(cut) {
        cut -= 1;
    }
    value.truncate(cut);
}

pub(crate) fn visible_text_with_visibility(
    element: ElementRef,
    hidden: fn(&ElementRef) -> bool,
) -> String {
    let mut out = String::new();
    push_text(element, &mut out, hidden);
    collapse(&out)
}

/// An anchor's text label, falling back to its accessibility label.
pub(crate) fn link_label(element: ElementRef) -> String {
    let label = collapse(&element.text().collect::<String>());
    if label.is_empty() {
        collapse(element.value().attr("aria-label").unwrap_or_default())
    } else {
        label
    }
}

pub(crate) fn image_source<'a>(element: &'a ElementRef<'a>) -> Option<&'a str> {
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
