//! An Email's HTML boiled down for Mail triage: readable text with data tables
//! kept as `cell | cell` rows and footers demoted to the end, the preheader,
//! links ranked by purchase cues, content images (tracking pixels dropped),
//! structured data, and the purchase cues the full text carries. The caller
//! re-checks every cue against the bounded view it finally sends, reporting
//! clipped purchase evidence to the classifier without replacing its verdict.

use scraper::{ElementRef, Html, Node, Selector};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

use crate::page::{
    collapse, image_source, is_block, is_hidden, link_label, resolve, select, truncate_utf8,
    visible_text,
};

const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_LINKS: usize = 500;
const MAX_IMAGES: usize = 300;
const MAX_STRUCTURED_BLOCKS: usize = 20;
const MAX_STRUCTURED_BYTES: usize = 512 * 1024;
const MAX_MICRODATA_PROPS: usize = 60;
const MAX_CUES: usize = 200;
const MAX_PREHEADER_BYTES: usize = 1024;

#[derive(Tsify, Serialize, Deserialize, Debug, PartialEq)]
#[tsify(into_wasm_abi)]
pub struct WEmailLink {
    pub href: String,
    pub text: String,
    /// The label or URL names an order, receipt, invoice, shipment or payment.
    pub cue: bool,
    /// Purchase tokens in the URL that must survive caller clipping.
    pub url_cues: Vec<String>,
}

#[derive(Tsify, Serialize, Deserialize, Debug, PartialEq)]
#[tsify(into_wasm_abi)]
pub struct WEmailImage {
    pub src: String,
    pub alt: String,
    /// The source or alt text names a purchase, or the alt text carries an amount.
    pub cue: bool,
    /// Purchase tokens in the image source that must survive caller clipping.
    pub url_cues: Vec<String>,
}

/// Purchase cues and how many distinct ones fell past the cue bound.
#[derive(Tsify, Serialize, Deserialize, Debug, PartialEq)]
#[tsify(into_wasm_abi)]
pub struct WPurchaseCues {
    pub cues: Vec<String>,
    /// Distinct cues past the bound. A caller cannot check these against its
    /// view, so any clipping must count as clipped purchase evidence.
    pub omitted: u32,
}

#[derive(Tsify, Serialize, Deserialize, Debug, PartialEq)]
#[tsify(into_wasm_abi)]
pub struct WCompactEmail {
    /// Readable body: data tables as `cell | cell` rows, layout tables
    /// flattened, footer and unsubscribe lines last.
    pub text: String,
    /// The hidden summary an inbox shows beside the subject, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preheader: Option<String>,
    /// Cue-bearing links first, then document order.
    pub links: Vec<WEmailLink>,
    /// Cue-bearing links past the link bound.
    pub cue_links_omitted: u32,
    /// Content images in document order; declared 1×1 or zero-size pixels are dropped.
    pub images: Vec<WEmailImage>,
    pub cue_images_omitted: u32,
    /// Non-tracking images whose source could not be represented.
    pub unresolved_images: u32,
    /// All content pictures past the image bound, including unlabeled pictures.
    pub images_omitted: u32,
    /// JSON-LD blocks verbatim, then each top-level microdata item as JSON.
    pub structured_data: Vec<String>,
    pub structured_data_omitted: u32,
    /// Amounts, order/invoice numbers and receipt phrases found in the
    /// preheader and the whole text, before any caller truncation.
    pub cues: Vec<String>,
    /// Distinct cues past the cue bound (see `WPurchaseCues::omitted`).
    pub cues_omitted: u32,
    /// Letters and digits outside footer lines: near zero means the content
    /// lives in images the view cannot show.
    pub readable_chars: u32,
    /// Readable purchase evidence was omitted or body/preheader text hit a bound.
    pub truncated: bool,
}

/// Inline style declarations as lowercase `(property, value)` pairs.
fn style_declarations(style: &str) -> Vec<(String, String)> {
    style
        .split(';')
        .filter_map(|declaration| {
            let (property, value) = declaration.split_once(':')?;
            let value = value.trim().to_ascii_lowercase();
            let value = value.trim_end_matches("!important").trim().to_string();
            Some((property.trim().to_ascii_lowercase(), value))
        })
        .collect()
}

fn leading_number(raw: &str) -> Option<u32> {
    let digits: String = raw
        .trim()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

fn is_zero(value: &str) -> bool {
    value
        .trim_end_matches("px")
        .trim()
        .parse::<f32>()
        .is_ok_and(|number| number <= 0.0)
}

/// Text no mail client renders. `font-size:0` alone is not hidden: templates
/// set it on wrapper cells to kill inline-block gaps and reset it inside.
fn is_email_hidden(element: &ElementRef) -> bool {
    if is_hidden(element) {
        return true;
    }
    let Some(style) = element.value().attr("style") else {
        return false;
    };
    let declarations = style_declarations(style);
    let value = |name: &str| {
        declarations
            .iter()
            .find(|(property, _)| property == name)
            .map(|(_, value)| value.as_str())
    };
    value("display") == Some("none")
        || value("visibility") == Some("hidden")
        || value("opacity").is_some_and(is_zero)
        || (value("overflow") == Some("hidden")
            && (value("max-height").is_some_and(is_zero) || value("height").is_some_and(is_zero)))
}

fn has_hidden_ancestor(element: &ElementRef) -> bool {
    element
        .ancestors()
        .filter_map(ElementRef::wrap)
        .any(|ancestor| is_email_hidden(&ancestor))
}

fn is_footer(element: &ElementRef) -> bool {
    let value = element.value();
    value.name() == "footer"
        || value.attr("role") == Some("contentinfo")
        || value
            .attr("class")
            .into_iter()
            .chain(value.attr("id"))
            .any(|name| name.to_ascii_lowercase().contains("footer"))
}

const FOOTER_PHRASES: &[&str] = &[
    "unsubscribe",
    "manage preferences",
    "manage your preferences",
    "email preferences",
    "view this email in",
    "view in browser",
    "view it in your browser",
    "privacy policy",
    "you received this",
    "you are receiving this",
    "you're receiving this",
    "©",
];

fn is_footer_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    FOOTER_PHRASES.iter().any(|phrase| lower.contains(phrase))
}

/// Letters and digits outside footer lines and bare URLs. Triage applies the
/// same count to an HTML body and its plain-text alternative, so footer
/// boilerplate in either cannot make an image-only receipt look readable. A
/// line with any footer phrase counts as nothing, even when it opens with
/// content: undercounting only sends an image-heavy message to review, while
/// counting footer prose would let a missed receipt stand as unrelated.
#[wasm_bindgen]
pub fn readable_chars(text: &str) -> u32 {
    let count = text
        .lines()
        .filter(|line| !is_footer_line(line))
        .flat_map(str::split_whitespace)
        .filter(|word| {
            let scheme = word.get(..8).unwrap_or(word).to_ascii_lowercase();
            !scheme.starts_with("http://") && !scheme.starts_with("https://")
        })
        .flat_map(str::chars)
        .filter(|c| c.is_alphanumeric())
        .count();
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// Preheader padding (combining grapheme joiners, zero-width characters,
/// soft hyphens) that renders as nothing; collapsed whitespace covers `&nbsp;`.
fn clean(text: &str) -> String {
    collapse(
        &text
            .chars()
            .filter(|c| {
                !matches!(
                    c,
                    '\u{034F}'
                        | '\u{200B}'
                        | '\u{200C}'
                        | '\u{200D}'
                        | '\u{2060}'
                        | '\u{FEFF}'
                        | '\u{00AD}'
                )
            })
            .collect::<String>(),
    )
}

fn is_quantity(cell: &str) -> bool {
    let lower = cell.to_lowercase();
    let digits = lower
        .trim_start_matches(['x', '×'])
        .trim_end_matches(['x', '×'])
        .trim();
    (!digits.is_empty() && digits.len() <= 4 && digits.chars().all(|c| c.is_ascii_digit()))
        || lower.starts_with("qty")
        || lower.starts_with("quantity")
}

/// A table of records rather than layout: no nested table, at least two rows,
/// at least 80% of rows sharing one column count of two or more, and a money
/// or quantity cell. Returns its rows' non-empty cell texts.
fn data_table_rows(table: ElementRef) -> Option<Vec<Vec<String>>> {
    let nested = Selector::parse("table").ok()?;
    if table.select(&nested).any(|inner| inner.id() != table.id()) {
        return None;
    }
    let row_selector = Selector::parse("tr").ok()?;
    let rows: Vec<Vec<String>> = table
        .select(&row_selector)
        .filter(|row| !is_email_hidden(row))
        .map(|row| {
            row.children()
                .filter_map(ElementRef::wrap)
                .filter(|cell| matches!(cell.value().name(), "td" | "th") && !is_email_hidden(cell))
                .map(|cell| clean(&visible_text(cell)))
                .collect::<Vec<_>>()
        })
        .filter(|cells| cells.iter().any(|cell| !cell.is_empty()))
        .collect();
    if rows.len() < 2 {
        return None;
    }
    let mut counts = std::collections::BTreeMap::<usize, usize>::new();
    for row in &rows {
        *counts.entry(row.len()).or_default() += 1;
    }
    let (columns, matching) = counts.into_iter().max_by_key(|(_, rows)| *rows)?;
    let consistent = columns >= 2 && matching * 5 >= rows.len() * 4;
    let records = rows
        .iter()
        .flatten()
        .any(|cell| !currency_amounts(cell).is_empty() || is_quantity(cell));
    (consistent && records).then(|| {
        rows.into_iter()
            .map(|cells| cells.into_iter().filter(|cell| !cell.is_empty()).collect())
            .collect()
    })
}

#[derive(Default)]
struct Walk {
    main: String,
    footer: String,
    preheader: Option<String>,
    visible_seen: bool,
    truncated: bool,
}

impl Walk {
    fn full(&self) -> bool {
        self.main.len() + self.footer.len() >= MAX_TEXT_BYTES
    }

    fn out(&mut self, footer: bool) -> &mut String {
        if footer {
            &mut self.footer
        } else {
            &mut self.main
        }
    }
}

fn newline(out: &mut String) {
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
}

fn walk(element: ElementRef, footer: bool, state: &mut Walk) {
    if state.full() {
        state.truncated = true;
        return;
    }
    let name = element.value().name();
    if is_email_hidden(&element) {
        if !matches!(
            name,
            "script" | "style" | "noscript" | "template" | "svg" | "head"
        ) {
            // Hidden text does not include image labels or link destinations.
            state.truncated |= element
                .descendants()
                .filter_map(ElementRef::wrap)
                .any(|node| {
                    ["alt", "src", "href"]
                        .iter()
                        // A fixed one-pixel picture cannot carry readable pixels;
                        // its label and surrounding links can still carry evidence.
                        .filter(|name| {
                            (**name != "src" || !is_fixed_tracking_pixel(&node))
                                && (**name != "href"
                                    || node.value().name() != "a"
                                    || node
                                        .value()
                                        .attr("href")
                                        .and_then(|raw| {
                                            // URL encoding can erase an amount cue.
                                            resolve(None, raw).filter(|resolved| {
                                                let retained = url_purchase_cues(resolved);
                                                url_purchase_cues(raw)
                                                    .iter()
                                                    .all(|cue| retained.contains(cue))
                                            })
                                        })
                                        .is_none())
                        })
                        .filter_map(|name| node.value().attr(name))
                        .any(|value| cue_hits(value) > 0 || !purchase_cues(value).cues.is_empty())
                });
        }
        // The preheader is the hidden summary placed before any visible text.
        if state.preheader.is_none()
            && !state.visible_seen
            && !matches!(
                name,
                "script" | "style" | "noscript" | "template" | "svg" | "head"
            )
        {
            let mut text = clean(&element.text().collect::<String>());
            state.truncated |= text.len() > MAX_PREHEADER_BYTES;
            truncate_utf8(&mut text, MAX_PREHEADER_BYTES);
            if !text.is_empty() {
                state.preheader = Some(text);
            }
        } else if !matches!(
            name,
            "script" | "style" | "noscript" | "template" | "svg" | "head"
        ) {
            let hidden_text = clean(&element.text().collect::<String>());
            let omitted = purchase_cues(&hidden_text);
            state.truncated |= !omitted.cues.is_empty() || omitted.omitted > 0;
        }
        return;
    }
    let footer = footer || is_footer(&element);
    if name == "table"
        && let Some(rows) = data_table_rows(element)
    {
        let out = state.out(footer);
        newline(out);
        for row in rows {
            out.push_str(&row.join(" | "));
            out.push('\n');
        }
        state.visible_seen = true;
        return;
    }
    let block = is_block(name);
    if block {
        newline(state.out(footer));
    }
    for child in element.children() {
        match child.value() {
            Node::Text(text) => {
                let cleaned = clean(text);
                if cleaned.is_empty() {
                    continue;
                }
                state.visible_seen = true;
                let out = state.out(footer);
                if !out.is_empty() && !out.ends_with('\n') && !out.ends_with(' ') {
                    out.push(' ');
                }
                out.push_str(&cleaned);
            }
            Node::Element(_) => {
                if let Some(child) = ElementRef::wrap(child) {
                    walk(child, footer, state);
                }
            }
            _ => {}
        }
        if state.full() {
            state.truncated = true;
            break;
        }
    }
    if block {
        newline(state.out(footer));
    }
}

const CURRENCY_SYMBOLS: &[char] = &['$', '€', '£', '¥', '₹', '₩'];
const CURRENCY_CODES: &[&str] = &[
    "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "JPY", "CHF", "MXN", "INR", "SEK", "NOK", "DKK",
];

fn starts_word(text: &str, index: usize) -> bool {
    text[..index]
        .chars()
        .next_back()
        .is_none_or(|c| !c.is_alphanumeric())
}

fn ends_word(text: &str, index: usize) -> bool {
    text[index..]
        .chars()
        .next()
        .is_none_or(|c| !c.is_alphanumeric())
}

/// The end of a digit run with `,`/`.` separators starting at `start`, without
/// a trailing separator.
fn number_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if !bytes.get(start).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    let mut end = start;
    let mut last_digit = start;
    while let Some(byte) = bytes.get(end) {
        if byte.is_ascii_digit() {
            last_digit = end + 1;
        } else if !matches!(byte, b',' | b'.') {
            break;
        }
        end += 1;
    }
    Some(last_digit)
}

/// Amounts written with a currency symbol or ISO code on either side, exactly
/// as they appear (`$12.00`, `USD 12`, `12,00 €`).
fn currency_amounts(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut index = 0;
    while let Some(c) = text[index..].chars().next() {
        let rest = &text[index..];
        let prefix = if CURRENCY_SYMBOLS.contains(&c) {
            Some(c.len_utf8())
        } else if starts_word(text, index) {
            CURRENCY_CODES
                .iter()
                .find(|code| rest.starts_with(**code))
                .map(|code| code.len())
        } else {
            None
        };
        if let Some(length) = prefix {
            let mut digits = index + length;
            if text[digits..].starts_with(' ') {
                digits += 1;
            }
            if let Some(end) = number_end(text, digits) {
                found.push(&text[index..end]);
                index = end;
                continue;
            }
        }
        if c.is_ascii_digit()
            && starts_word(text, index)
            && let Some(end) = number_end(text, index)
        {
            let gap = usize::from(text[end..].starts_with(' '));
            let tail = &text[end + gap..];
            // `1 $24.00` (a quantity cell, then a price) is not `1 $`.
            let suffix = tail
                .chars()
                .next()
                .filter(|symbol| {
                    CURRENCY_SYMBOLS.contains(symbol)
                        && number_end(tail.trim_start_matches(*symbol).trim_start(), 0).is_none()
                })
                .map(char::len_utf8)
                .or_else(|| {
                    CURRENCY_CODES
                        .iter()
                        .find(|code| tail.starts_with(**code) && ends_word(tail, code.len()))
                        .map(|code| code.len())
                });
            if let Some(length) = suffix {
                let stop = end + gap + length;
                found.push(&text[index..stop]);
                index = stop;
            } else {
                index = end;
            }
            continue;
        }
        index += c.len_utf8();
    }
    found
}

const ID_KEYWORDS: &[&str] = &[
    "order",
    "invoice",
    "receipt",
    "confirmation",
    "transaction",
    "booking",
    "reservation",
    "reference",
    "shipment",
    "tracking",
];
const ID_CONNECTORS: &[&str] = &[
    "", "#", "no", "number", "num", "nr", "id", "is", "code", "ref",
];
const RECEIPT_PHRASES: &[&str] = &[
    "receipt",
    "invoice",
    "order confirmation",
    "order number",
    "order total",
    "subtotal",
    "amount paid",
    "total paid",
    "amount due",
    "payment received",
    "refund",
    "tracking number",
    "has shipped",
    "booking",
    "reservation",
    "flight",
    "payout",
    "your purchase",
    "you purchased",
    "you returned",
];

fn trim_token(token: &str) -> &str {
    token.trim_matches(|c: char| {
        matches!(
            c,
            ':' | '#' | '.' | ',' | ';' | '(' | ')' | '[' | ']' | '"' | '\'' | '<' | '>'
        )
    })
}

/// An order, invoice or tracking identifier: 3–40 letters, digits, `-`, `_` or
/// `/`, with at least one digit.
fn is_identifier(token: &str) -> bool {
    (3..=40).contains(&token.len())
        && token.chars().any(|c| c.is_ascii_digit())
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/'))
}

/// Identifiers a keyword introduces (`Order #A-123`, `Invoice no. 42`,
/// `order:123`) and bare `#`-prefixed identifiers with three or more digits.
fn identifiers(text: &str) -> Vec<&str> {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let mut found = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        let lower = token.to_lowercase();
        if let Some(rest) = token.strip_prefix('#') {
            let rest = trim_token(rest);
            if is_identifier(rest) && rest.chars().filter(char::is_ascii_digit).count() >= 3 {
                found.push(rest);
                continue;
            }
        }
        let Some(keyword) = ID_KEYWORDS
            .iter()
            .find(|keyword| lower.starts_with(**keyword))
        else {
            continue;
        };
        // `order#123` / `order:123` in one token.
        let attached = trim_token(token.get(keyword.len()..).unwrap_or_default());
        if is_identifier(attached) {
            found.push(attached);
            continue;
        }
        if trim_token(&lower) != *keyword {
            continue;
        }
        let candidate = tokens
            .iter()
            .skip(index + 1)
            .take(4)
            .map(|next| trim_token(next))
            .find(|next| !ID_CONNECTORS.contains(&next.to_lowercase().as_str()));
        if let Some(candidate) = candidate.filter(|candidate| is_identifier(candidate)) {
            found.push(candidate);
        }
    }
    found
}

/// Purchase cues in `text`: currency amounts and order/invoice identifiers as
/// they appear, then receipt phrases in lowercase. A caller checks each one
/// against its final view (case-insensitively) to tell whether a bound clipped
/// purchase evidence.
#[wasm_bindgen]
pub fn purchase_cues(text: &str) -> WPurchaseCues {
    let lower = text.to_lowercase();
    let mut seen = std::collections::HashSet::new();
    let mut cues: Vec<String> = currency_amounts(text)
        .into_iter()
        .chain(identifiers(text))
        .map(str::to_string)
        .chain(
            RECEIPT_PHRASES
                .iter()
                .filter(|phrase| lower.contains(**phrase))
                .map(|phrase| (*phrase).to_string()),
        )
        .filter(|cue| seen.insert(cue.to_lowercase()))
        .collect();
    // Amounts come first, so an advertised price list must not hide a later
    // receipt's identifiers: the overflow is reported, never silently dropped.
    let omitted = cues.len().saturating_sub(MAX_CUES);
    cues.truncate(MAX_CUES);
    WPurchaseCues {
        cues,
        omitted: u32::try_from(omitted).unwrap_or(u32::MAX),
    }
}

const LINK_CUES: &[&str] = &[
    "order",
    "receipt",
    "invoice",
    "track",
    "shipment",
    "shipping",
    "package",
    "deliver",
    "return",
    "refund",
    "billing",
    "payment",
    "subscription",
    "purchase",
    "transaction",
];

fn cue_hits(value: &str) -> usize {
    let lower = value.to_lowercase();
    LINK_CUES.iter().filter(|cue| lower.contains(**cue)).count()
}

fn url_purchase_cues(value: &str) -> Vec<String> {
    let lower = value.to_lowercase();
    LINK_CUES
        .iter()
        .filter(|cue| lower.contains(**cue))
        .map(|cue| (*cue).to_string())
        .chain(purchase_cues(value).cues)
        .collect()
}

fn is_fixed_tracking_pixel(image: &ElementRef) -> bool {
    if image.value().name() != "img" {
        return false;
    }
    let pixel_number = |value: &str| {
        value
            .trim()
            .strip_suffix("px")
            .unwrap_or(value.trim())
            .parse::<f32>()
            .ok()
    };
    let (width, height) = image_dimensions(image, pixel_number);
    let tiny = |value| pixel_number(value).is_some_and(|value| (0.0..=1.0).contains(&value));
    // Conflicting CSS can render an attribute-sized pixel as a real picture.
    let styles = image
        .value()
        .attr("style")
        .map(style_declarations)
        .unwrap_or_default();
    width.is_some_and(|width| (0.0..=1.0).contains(&width))
        && height.is_some_and(|height| (0.0..=1.0).contains(&height))
        && styles
            .iter()
            .filter(|(name, _)| {
                matches!(
                    name.as_str(),
                    "width" | "height" | "min-width" | "min-height"
                )
            })
            .all(|(_, value)| tiny(value))
}

fn image_dimensions<T>(
    image: &ElementRef,
    parse: impl Fn(&str) -> Option<T>,
) -> (Option<T>, Option<T>) {
    let declarations = image
        .value()
        .attr("style")
        .map(style_declarations)
        .unwrap_or_default();
    let size = |name: &str| {
        image.value().attr(name).and_then(&parse).or_else(|| {
            declarations
                .iter()
                .find(|(property, _)| property == name)
                .and_then(|(_, value)| parse(value))
        })
    };
    (size("width"), size("height"))
}

fn is_tracking_pixel(image: &ElementRef) -> bool {
    let (width, height) = image_dimensions(image, leading_number);
    width == Some(0)
        || height == Some(0)
        || (width.is_some_and(|w| w <= 1) && height.is_some_and(|h| h <= 1))
}

fn microdata(document: &Html) -> Vec<String> {
    let Ok(property) = Selector::parse("[itemprop]") else {
        return Vec::new();
    };
    select(document, "[itemscope][itemtype]")
        .into_iter()
        .filter(|scope| {
            !scope
                .ancestors()
                .filter_map(ElementRef::wrap)
                .any(|ancestor| ancestor.value().attr("itemscope").is_some())
        })
        .map(|scope| {
            let mut item = serde_json::Map::new();
            item.insert(
                "@microdata".into(),
                scope.value().attr("itemtype").unwrap_or_default().into(),
            );
            for prop in scope.select(&property).take(MAX_MICRODATA_PROPS) {
                let value = prop.value();
                let Some(name) = value.attr("itemprop") else {
                    continue;
                };
                let content = value
                    .attr("content")
                    .or_else(|| value.attr("href"))
                    .or_else(|| value.attr("src"))
                    .map(str::to_string)
                    .unwrap_or_else(|| collapse(&prop.text().collect::<String>()));
                item.entry(name.to_string()).or_insert(content.into());
            }
            serde_json::Value::Object(item).to_string()
        })
        .collect()
}

#[wasm_bindgen]
pub fn compact_email_html(html: &str) -> WCompactEmail {
    let document = Html::parse_document(html);

    let mut state = Walk::default();
    if let Some(body) = select(&document, "body").into_iter().next() {
        walk(body, false, &mut state);
    }
    let mut kept = Vec::new();
    let mut demoted = Vec::new();
    for line in state
        .main
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if is_footer_line(line) {
            demoted.push(line);
        } else {
            kept.push(line);
        }
    }
    let readable_chars = readable_chars(&state.main);
    let mut text = kept
        .into_iter()
        .chain(demoted)
        .chain(
            state
                .footer
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty()),
        )
        .collect::<Vec<_>>()
        .join("\n");
    let WPurchaseCues {
        cues,
        omitted: cues_omitted,
    } = purchase_cues(&format!(
        "{}\n{text}",
        state.preheader.as_deref().unwrap_or_default()
    ));
    truncate_utf8(&mut text, MAX_TEXT_BYTES);

    let mut links: Vec<(usize, WEmailLink)> = Vec::new();
    for anchor in select(&document, "a[href]") {
        if anchor.ancestors().filter_map(ElementRef::wrap).any(|node| {
            matches!(
                node.value().name(),
                "script" | "style" | "noscript" | "template" | "svg" | "head"
            )
        }) {
            continue;
        }
        let Some(href) = anchor
            .value()
            .attr("href")
            .and_then(|raw| resolve(None, raw))
        else {
            continue;
        };
        let mut text = clean(&link_label(anchor));
        if text.is_empty() {
            // An image link reads as its picture's alt text.
            text = anchor
                .descendants()
                .filter_map(ElementRef::wrap)
                .find_map(|child| child.value().attr("alt").map(clean))
                .unwrap_or_default();
        }
        // A responsive copy can give one destination a different evidence label.
        if links
            .iter()
            .any(|(_, link)| link.href == href && link.text == text)
        {
            continue;
        }
        let score = cue_hits(&text) * 2 + cue_hits(&href);
        let url_cues = url_purchase_cues(&href);
        links.push((
            score,
            WEmailLink {
                href,
                text,
                cue: score > 0 || !url_cues.is_empty(),
                url_cues,
            },
        ));
    }
    // Stable: equally ranked links keep document order.
    links.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    let cue_links_omitted = links
        .iter()
        .skip(MAX_LINKS)
        .filter(|(_, link)| link.cue)
        .count();
    let links = links
        .into_iter()
        .take(MAX_LINKS)
        .map(|(_, link)| link)
        .collect();

    let mut unresolved_images = 0u32;
    let images: Vec<WEmailImage> = select(&document, "img")
        .into_iter()
        .filter(|image| !is_tracking_pixel(image) && !has_hidden_ancestor(image))
        .filter_map(|image| {
            let Some(src) = image_source(&image).and_then(|source| resolve(None, source)) else {
                unresolved_images = unresolved_images.saturating_add(1);
                return None;
            };
            let alt = clean(image.value().attr("alt").unwrap_or_default());
            let url_cues = url_purchase_cues(&src);
            let cue =
                cue_hits(&alt) > 0 || !url_cues.is_empty() || !purchase_cues(&alt).cues.is_empty();
            Some(WEmailImage {
                src,
                alt,
                cue,
                url_cues,
            })
        })
        .collect();
    let cue_images_omitted = images
        .iter()
        .skip(MAX_IMAGES)
        .filter(|image| image.cue)
        .count();
    let images_omitted = u32::try_from(images.len().saturating_sub(MAX_IMAGES)).unwrap_or(u32::MAX);
    let images = images.into_iter().take(MAX_IMAGES).collect();

    let mut structured_data = Vec::new();
    let mut structured_data_omitted = 0u32;
    let json_ld = select(&document, r#"script[type="application/ld+json"]"#)
        .into_iter()
        .map(|script| script.text().collect::<String>())
        .filter(|raw| !raw.trim().is_empty())
        .map(|raw| raw.trim().to_string());
    for block in json_ld.chain(microdata(&document)) {
        if block.len() > MAX_STRUCTURED_BYTES || structured_data.len() >= MAX_STRUCTURED_BLOCKS {
            structured_data_omitted += 1;
        } else {
            structured_data.push(block);
        }
    }

    WCompactEmail {
        text,
        preheader: state.preheader,
        links,
        cue_links_omitted: u32::try_from(cue_links_omitted).unwrap_or(u32::MAX),
        images,
        cue_images_omitted: u32::try_from(cue_images_omitted).unwrap_or(u32::MAX),
        unresolved_images,
        images_omitted,
        structured_data,
        structured_data_omitted,
        cues,
        cues_omitted,
        readable_chars,
        truncated: state.truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_hidden_link_evidence_without_a_false_text_omission() {
        let email = compact_email_html(
            r#"<p>Community newsletter with gardening tips and upcoming neighborhood events.</p><a href="https://example.test/subscription" style="display:none">Manage preferences</a>"#,
        );
        assert!(!email.truncated);
        assert!(email.links.iter().any(|link| {
            link.href == "https://example.test/subscription" && link.text == "Manage preferences"
        }));

        let receipt = compact_email_html(
            r#"<p>Account updates.</p><div style="display:none"><a href="https://example.test/receipt">Receipt for order #SYN-12345 paid $42</a></div>"#,
        );
        assert!(receipt.truncated);
        assert!(
            receipt
                .links
                .iter()
                .any(|link| link.text.contains("SYN-12345"))
        );

        let malformed = compact_email_html(
            r#"<p>Account updates.</p><a style="display:none" href="receipt without a valid URL">Learn more</a>"#,
        );
        assert!(malformed.truncated);

        let normalized_away = compact_email_html(
            r#"<p>Community updates.</p><a style="display:none" href="https://example.test/pay?amount=USD 42">Learn more</a>"#,
        );
        assert!(normalized_away.truncated);

        let many = (0..MAX_LINKS + 1).map(|i| {
            format!(r#"<a style="display:none" href="https://example.test/track/{i}">Account link</a>"#)
        }).collect::<String>();
        let bounded = compact_email_html(&many);
        assert_eq!(bounded.links.len(), MAX_LINKS);
        assert_eq!(bounded.cue_links_omitted, 1);

        let duplicated = compact_email_html(
            r#"<a href="https://example.test/subscription">Preferences</a><div style="display:none"><a href="https://example.test/subscription">Account support</a></div>"#,
        );
        assert_eq!(duplicated.links.len(), 2);
        assert!(
            duplicated
                .links
                .iter()
                .any(|link| link.text == "Account support")
        );

        let inert = compact_email_html(
            r#"<p>Community updates.</p><template><a href="https://example.test/receipt">Receipt template</a></template>"#,
        );
        assert!(inert.links.is_empty());
    }

    #[test]
    fn hidden_tracking_pixels_do_not_omit_purchase_evidence() {
        let email = compact_email_html(
            r#"<p>Community updates and gardening tips.</p><div style="display:none"><img width="1" height="1" src="https://example.test/track/return/open.gif"></div>"#,
        );
        assert!(!email.truncated);
        assert!(email.images.is_empty());

        for dimensions in [
            r#"width="600" height="400""#,
            r#"width="600" height="0""#,
            r#"width="0" height="400""#,
            r#"style="width:1%;height:1em""#,
            r#"width="1" height="1" style="width:600px;height:400px""#,
            r#"width="1" height="1" style="min-width:600px;min-height:400px""#,
            r#"style="width:1px;width:600px;height:1px""#,
            "",
        ] {
            let receipt = compact_email_html(&format!(
                r#"<p>Community updates.</p><div style="display:none"><img {dimensions} src="https://example.test/receipt.png"></div>"#,
            ));
            assert!(receipt.truncated, "receipt dimensions: {dimensions}");
        }
        let labeled_pixel = compact_email_html(
            r#"<p>Community updates.</p><div style="display:none"><img width="1" height="1" src="https://example.test/open.gif" alt="Receipt total $24"></div>"#,
        );
        assert!(labeled_pixel.truncated);
    }

    const ORDER_TABLE: &str = include_str!("../fixtures/email/order-table.html");
    const NEWSLETTER: &str = include_str!("../fixtures/email/newsletter.html");
    const IMAGE_ONLY: &str = include_str!("../fixtures/email/image-only-receipt.html");
    const FORWARDED: &str = include_str!("../fixtures/email/forwarded.html");
    const JSON_LD_ORDER: &str = include_str!("../fixtures/email/json-ld-order.html");

    #[test]
    fn renders_an_order_confirmation_data_table_as_rows() {
        let email = compact_email_html(ORDER_TABLE);
        assert_eq!(
            email.preheader.as_deref(),
            Some("Order #SYN-40217 is confirmed")
        );
        assert!(
            email.text.contains(
                "Item | Qty | Price\nStoneware mixing bowl, 3 qt | 1 | $24.00\nBamboo spatula set | 2 | $18.50"
            ),
            "{}",
            email.text
        );
        assert!(email.text.contains("Order total | $54.20"));
        // The outer layout tables flatten to plain lines.
        assert!(
            email
                .text
                .starts_with("My account\nThanks for your order, Sam!")
        );
        // Footer lines move after the content.
        let footer = email.text.find("Unsubscribe").unwrap();
        assert!(footer > email.text.find("Track package").unwrap());
        assert!(
            email
                .text
                .ends_with("Example Shop, 100 Sample Street, Springfield")
        );
        assert!(!email.text.contains("color: #ffffff"));
        for cue in ["$24.00", "$54.20", "SYN-40217", "subtotal", "order total"] {
            assert!(
                email.cues.iter().any(|found| found == cue),
                "{cue}: {:?}",
                email.cues
            );
        }
        assert_eq!(
            email
                .links
                .iter()
                .map(|link| link.text.as_str())
                .collect::<Vec<_>>(),
            vec![
                "Track package",
                "View order",
                "Example Shop",
                "My account",
                "Shop the spring sale",
                "Unsubscribe",
                "Privacy policy"
            ]
        );
        assert!(email.links[0].cue && email.links[1].cue && !email.links[2].cue);
        // The 1×1 open pixel is dropped; the logo stays.
        assert_eq!(email.images.len(), 1);
        assert_eq!(email.images[0].alt, "Example Shop");
        assert!(!email.truncated);
    }

    #[test]
    fn keeps_a_newsletter_readable_without_purchase_cues() {
        let email = compact_email_html(NEWSLETTER);
        assert_eq!(
            email.preheader.as_deref(),
            Some("Five things to plant before the frost")
        );
        assert_eq!(email.cues, Vec::<String>::new());
        assert!(email.links.iter().all(|link| !link.cue));
        assert!(email.text.contains("Garlic, shallots and broad beans"));
        assert!(email.text.ends_with("Manage preferences | Unsubscribe"));
        // A missing alt never drops an image; the zero-size pixel is dropped.
        assert_eq!(email.images.len(), 3);
        assert_eq!(email.images[2].alt, "");
        assert!(email.readable_chars > 200);
    }

    #[test]
    fn reports_an_image_only_receipt_as_unreadable() {
        let email = compact_email_html(IMAGE_ONLY);
        assert_eq!(email.images.len(), 1);
        assert_eq!(
            email.images[0].src,
            "https://mail.example.test/receipt-body.png"
        );
        assert_eq!(email.readable_chars, 0);
        assert_eq!(email.cues, Vec::<String>::new());
    }

    #[test]
    fn reads_a_forwarded_invoice_inside_its_quote() {
        let email = compact_email_html(FORWARDED);
        assert!(
            email
                .text
                .contains("Invoice INV-20931 for the billing period")
        );
        assert!(email.text.contains("Water | 4,200 gal | $41.10"));
        assert!(email.text.contains("Amount due | $120.00"));
        for cue in ["INV-20931", "$120.00", "invoice", "amount due"] {
            assert!(
                email.cues.iter().any(|found| found == cue),
                "{cue}: {:?}",
                email.cues
            );
        }
        assert_eq!(email.links[0].text, "View invoice");
    }

    #[test]
    fn keeps_json_ld_and_microdata_orders_verbatim() {
        let email = compact_email_html(JSON_LD_ORDER);
        assert_eq!(email.structured_data.len(), 1);
        assert!(email.structured_data[0].contains(r#""orderNumber": "EB-778201""#));
        assert_eq!(
            email.text,
            "Thanks for shopping with Example Books.\nHelp centre"
        );

        let micro = compact_email_html(
            r#"<html><body>Account update<div itemscope itemtype="http://schema.org/Order"><meta itemprop="orderNumber" content="synthetic-order"><span itemprop="price">12.00</span></div></body></html>"#,
        );
        assert_eq!(
            micro.structured_data,
            vec![r#"{"@microdata":"http://schema.org/Order","orderNumber":"synthetic-order","price":"12.00"}"#.to_string()]
        );
    }

    #[test]
    fn finds_amounts_and_identifiers_in_their_written_form() {
        assert_eq!(
            purchase_cues(
                "Paid USD 12 and 12,50 € then $ 3. Order no. 55-A1; order#X99 ref #1234; total 2026 visits"
            )
            .cues,
            vec!["USD 12", "12,50 €", "$ 3", "55-A1", "X99", "1234"]
        );
        assert_eq!(
            purchase_cues("USDA grade, 3 eggs, #ff00ff").cues,
            Vec::<String>::new()
        );
        assert_eq!(purchase_cues("Bowl 1 $24.00").cues, vec!["$24.00"]);
    }

    #[test]
    fn counts_no_footer_or_url_as_readable() {
        assert_eq!(
            readable_chars(
                "Unsubscribe from these emails\nPrivacy policy · © 2026 Synthetic Shop\nhttps://example.test/a"
            ),
            0
        );
        assert_eq!(readable_chars("Order 12\nUnsubscribe"), 7);
        // A scheme in capitals is still a URL, not readable text.
        assert_eq!(
            readable_chars(&format!("HTTPS://example.test/{}", "a".repeat(100))),
            0
        );
        assert_eq!(
            readable_chars(
                "For assistance with this message please contact Synthetic Shop at 123 Sample Avenue. To stop future messages, unsubscribe."
            ),
            0
        );
    }

    #[test]
    fn reports_cues_past_its_bound() {
        let prices = (0..MAX_CUES + 5)
            .map(|cents| format!("${}.{:02}", 10 + cents / 100, cents % 100))
            .collect::<Vec<_>>()
            .join(" ");
        let found = purchase_cues(&format!("{prices} Order no. SYN-40217"));
        assert_eq!(found.cues.len(), MAX_CUES);
        assert_eq!(found.omitted, 6);
        assert!(!found.cues.iter().any(|cue| cue == "SYN-40217"));
        assert_eq!(purchase_cues("Bowl 1 $24.00").omitted, 0);
    }

    #[test]
    fn reports_its_own_text_bound() {
        let body = "<p>Receipt line é</p>".repeat(MAX_TEXT_BYTES / 10);
        let email = compact_email_html(&format!(
            "<html><body>{body}<p>Total $9.99</p></body></html>"
        ));
        assert!(email.truncated);
        assert!(email.text.len() <= MAX_TEXT_BYTES);
        assert!(!email.text.contains("$9.99"));
    }
}
