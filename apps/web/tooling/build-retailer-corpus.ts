/**
 * Builds a synthetic retailer-order fixture corpus from a local "Save as"
 * capture of a real order-history session (Amazon order-details pages plus
 * Gmail order-confirmation pages). The input is never committed and is read
 * only from the path given on the command line.
 *
 * Every identifying value (order numbers, ASINs, names, addresses, dates,
 * prices, and product brand/model names) is replaced by a deterministically
 * generated synthetic value before anything is written out. Only Amazon's
 * own generic template vocabulary (data-component names, CSS class names,
 * section labels like "Order placed" or "Grand Total", and generic workwear
 * attribute words such as "Loose Fit" or "Steel Toe") is preserved, because
 * that vocabulary is what gives the fixture realistic structure without
 * carrying any private or real-entity value.
 *
 * Usage: tsx tooling/build-retailer-corpus.ts <inputDir> <outputDir>
 */
import { JSDOM } from "jsdom";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Deterministic synthesis primitives
// ---------------------------------------------------------------------------

/** Fully invented brand/model vocabulary — never a real retailer brand. */
const BRAND_POOL = [
  "Northwind Workwear",
  "Ridgeline Trade Co.",
  "Ironway Supply",
  "Fieldmark Goods",
  "Duravik Workwear",
  "Backroad Supply Co.",
] as const;
const MODEL_POOL = [
  "Trailhand",
  "Ridgecut",
  "Ironbrook",
  "Summitline",
  "Overlander",
  "Dockside",
] as const;
const SYNTHETIC_FIRST_NAMES = ["Jordan", "Casey", "Riley", "Morgan"] as const;
const SYNTHETIC_LAST_NAMES = [
  "Ashworth",
  "Bellamy",
  "Kestrel",
  "Marlowe",
] as const;
const SYNTHETIC_STREETS = [
  "48 Birchwood Ln",
  "215 Cedar Hollow Rd",
  "77 Millrace Ct",
  "930 Fernbrook Ave",
] as const;
const SYNTHETIC_CITIES = [
  { city: "Rivermill", state: "CA", zip: "94999-2451" },
  { city: "Ashbourne", state: "OR", zip: "97401-1188" },
] as const;

/**
 * Attribute vocabulary that stays in a product title: generic retail
 * workwear terms, fits, materials, and garment nouns. Never a brand name.
 * The earliest match in a real title marks where the (discarded) brand
 * prefix ends and the preserved "style" of the title begins.
 */
const TITLE_ATTRIBUTE_KEYWORDS = [
  "relaxed fit",
  "loose fit",
  "regular fit",
  "slim fit",
  "straight fit",
  "rugged flex",
  "heavyweight",
  "short-sleeve",
  "long-sleeve",
  "sleeveless",
  "6 inch",
  "steel toe",
  "safety toe",
  "pocket t-shirt",
  "duck bib overall",
  "bib overall",
  "dungaree",
  "pant",
  "t-shirt",
  "shirt",
  "boot",
  "sweatshirt",
  "jacket",
  "athletic",
  "unisex",
  "adult",
  "men's",
  "mens",
  "women's",
  "industrial",
  "comfort technology",
  "anti slip",
  "shock absorption",
  "leather",
  "construction",
];

/** Generic retail-vocabulary words that stay untouched wherever they occur
 * in the preserved part of a title: colors, sizes, and common garment/
 * material description words that are not themselves a brand or a product
 * line name. Anything capitalized that is NOT in this set (and not a
 * keyword word above) is treated as a brand/model word and replaced. */
const SAFE_TITLE_WORDS = new Set(
  [
    ...TITLE_ATTRIBUTE_KEYWORDS.flatMap((keyword) => keyword.split(/[\s-]+/u)),
    "black",
    "white",
    "brown",
    "navy",
    "olive",
    "orange",
    "wheat",
    "gray",
    "grey",
    "khaki",
    "blue",
    "tan",
    "green",
    "red",
    "dusty",
    "bright",
    "brite",
    "new",
    "double",
    "front",
    "firm",
    "heavy",
    "duty",
    "workwear",
    "comfort",
    "technology",
    "anti",
    "slip",
    "grip",
    "ultra",
    "shock",
    "absorption",
    "for",
    "and",
    "with",
    "to",
    "the",
    "of",
    "in",
    "or",
    "small",
    "medium",
    "large",
    "us",
    "x",
    "work",
    "dark",
    "men",
  ].map((word) => word.toLowerCase()),
);

function isSafeTitleWord(word: string): boolean {
  const lower = word.toLowerCase();
  if (SAFE_TITLE_WORDS.has(lower)) return true;
  for (const safe of SAFE_TITLE_WORDS) {
    if (safe.length >= 4 && (lower.startsWith(safe) || safe.startsWith(lower)))
      return true;
  }
  return false;
}

/** Simple mulberry32 seeded PRNG so the whole corpus build is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthesizeOrderId(index: number): string {
  const a = String(114 + index).padStart(3, "0");
  const b = String(7000001 + index * 111_113)
    .padStart(7, "0")
    .slice(-7);
  const c = String(4210007 + index * 133_331)
    .padStart(7, "0")
    .slice(-7);
  return `${a}-${b}-${c}`;
}

function synthesizeAsin(index: number): string {
  const digits = (1_000_000_007 + index * 97).toString(36).toUpperCase();
  return `B0${digits.padStart(8, "0").slice(-8)}`;
}

/** Replaces the leading brand/model words of a real title, keeping the
 * rest of the title's wording (fit, material, color, size) intact. Also
 * scrubs any repeat of a discarded brand word later in the title (some
 * retailers embed the brand a second time inside a color name). */
function synthesizeProductTitle(
  realTitle: string,
  globalIndex: number,
): string {
  let cutIndex = -1;
  for (const keyword of TITLE_ATTRIBUTE_KEYWORDS) {
    const pattern = new RegExp(
      `\\b${keyword.replace(/\s+/gu, "\\s+")}\\b`,
      "iu",
    );
    const match = pattern.exec(realTitle);
    if (match && (cutIndex === -1 || match.index < cutIndex))
      cutIndex = match.index;
  }
  const brandPart = cutIndex > 0 ? realTitle.slice(0, cutIndex) : "";
  let attributesPart = cutIndex >= 0 ? realTitle.slice(cutIndex) : realTitle;

  const brandWords = brandPart
    .split(/[\s,]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3);
  for (const word of brandWords) {
    attributesPart = attributesPart.replace(
      new RegExp(
        `\\b${word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`,
        "giu",
      ),
      "",
    );
  }

  // Bare 4+ digit runs are retailer style/model numbers, not sizes (sizes
  // carry a unit suffix like "US", "W", or "L", or use decimals like "9.5").
  attributesPart = attributesPart.replace(
    /\b\d{4,}\b(?!\s*(?:US|W\b|L\b|Inch))/giu,
    () => String(40_000 + ((globalIndex * 137) % 9_000)),
  );

  // Any remaining capitalized word that isn't generic retail vocabulary is
  // a product-line/model name (e.g. a real line name), not a brand: swap it
  // for an invented model word rather than dropping it, to keep the title
  // shape realistic.
  let modelWordIndex = 1;
  attributesPart = attributesPart.replace(/[A-Za-z]{3,}/gu, (word) => {
    if (word[0] !== word[0]!.toUpperCase()) return word;
    if (isSafeTitleWord(word)) return word;
    const replacement =
      MODEL_POOL[(globalIndex + modelWordIndex) % MODEL_POOL.length]!;
    modelWordIndex += 1;
    return replacement;
  });

  attributesPart = attributesPart
    .replace(/\s+/gu, " ")
    .replace(/^[\s,]+/u, "")
    .trim();
  const brand = BRAND_POOL[globalIndex % BRAND_POOL.length];
  const model = MODEL_POOL[globalIndex % MODEL_POOL.length];
  return `${brand} ${model} ${attributesPart}`.replace(/\s+/gu, " ").trim();
}

function formatAmazonDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Extraction (reads only real values needed to build a structurally faithful
// synthetic replacement; no real value is ever written to output).
// ---------------------------------------------------------------------------

interface RealOrderDetails {
  sourceFile: string;
  orderDateText: string | null;
  orderIdText: string | null;
  items: { asin: string; title: string; unitPrice: number | null }[];
  shipName: string | null;
}

function extractOrderDetails(
  html: string,
  sourceFile: string,
): RealOrderDetails {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const orderDateText =
    doc
      .querySelector('[data-component="orderDate"] span')
      ?.textContent?.trim() ?? null;
  const orderIdMatch = doc
    .querySelector('[data-component="orderId"] span')
    ?.textContent?.match(/\d{3}-\d{7}-\d{7}/u);
  const orderIdText = orderIdMatch?.[0] ?? null;

  const items: RealOrderDetails["items"] = [];
  for (const anchor of doc.querySelectorAll<HTMLAnchorElement>(
    '[data-component="itemTitle"] a',
  )) {
    const asinMatch = anchor
      .getAttribute("href")
      ?.match(/\/dp\/([A-Z0-9]{10})/u);
    if (!asinMatch) continue;
    const title = (anchor.textContent ?? "").replace(/\s+/gu, " ").trim();
    const row = anchor.closest("li");
    const priceText = row
      ?.querySelector('[data-component="unitPrice"] span')
      ?.textContent?.match(/\$([0-9]+\.[0-9]{2})/u)?.[1];
    items.push({
      asin: asinMatch[1]!,
      title,
      unitPrice: priceText ? Number(priceText) : null,
    });
  }

  const shipName =
    doc
      .querySelector('[data-component="shippingAddress"] li .a-list-item')
      ?.textContent?.replace(/\s+/gu, " ")
      .trim() ?? null;

  dom.window.close();
  return { sourceFile, orderDateText, orderIdText, items, shipName };
}

interface RealOrderEmail {
  sourceFile: string;
  orderIdText: string | null;
}

/**
 * Only the order id is extracted from a real confirmation email. Every other
 * field an email fixture needs (order date, item lines, totals) comes from
 * the matching order-details fixture(s) for the same order id (see
 * `ordersByOrderId` in buildRetailerCorpus) rather than being independently
 * re-derived from the email itself — that is what keeps an email/order pair
 * for the same order id in agreement on date, lines, and totals.
 */
function extractOrderEmail(html: string, sourceFile: string): RealOrderEmail {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const bodyText = doc.body?.textContent ?? "";
  const orderIdMatch = bodyText.match(/\d{3}-\d{7}-\d{7}/u);
  dom.window.close();
  return { sourceFile, orderIdText: orderIdMatch?.[0] ?? null };
}

// ---------------------------------------------------------------------------
// Rendering (builds a compact, realistic-looking Amazon/Gmail page skeleton
// using only Amazon's own generic template vocabulary plus synthetic data).
// ---------------------------------------------------------------------------

const PRICE_SCALE = 0.72;
const TAX_RATE = 0.0875;
const PLACEHOLDER_IMAGE =
  "https://www.amazon.example/images/placeholder-item.png";

interface SyntheticLine {
  asin: string;
  title: string;
  unitPrice: number;
}

interface SyntheticOrder {
  orderId: string;
  orderedAt: string; // ISO date, e.g. 2031-01-10
  orderDateLabel: string; // "January 10, 2031"
  lines: SyntheticLine[];
  subtotal: number;
  shipping: number;
  tax: number;
  grandTotal: number;
  shipName: string;
  shipStreet: string;
  shipCityStateZip: string;
  /** Set when this order id has more than one order-details page (a real
   * order shipped in separate shipments), e.g. "Shipment 1 of 2". Rendered
   * into the page and used by the corpus unit test to confirm the split is
   * documented rather than accidental. Null for a single-shipment order. */
  shipmentLabel: string | null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function renderOrderDetailsHtml(
  order: SyntheticOrder,
  pageIndex: number,
): string {
  const invoiceHref = `https://www.amazon.example/gp/css/summary/print.html?orderID=${order.orderId}`;
  const itemsHtml = order.lines
    .map(
      (line, lineIndex) => `
        <li><span class="a-list-item">
          <div class="a-row">
            <div class="a-column a-span2">
              <img class="a-dynamic-image" src="${PLACEHOLDER_IMAGE}" alt="">
            </div>
            <div class="a-column a-span7" data-component="itemTitle">
              <div class="a-row"><a class="a-link-normal" href="https://www.amazon.example/dp/${line.asin}?ref_=ppx_hzod_title_dt_b_fed_asin_title_${lineIndex}_0">${line.title}</a></div>
            </div>
            <div class="a-column a-span3 a-text-right a-span-last">
              <div data-component="quantity"><span>Qty: 1</span></div>
              <div data-component="unitPrice"><span class="a-size-base a-color-base">$${line.unitPrice.toFixed(2)}</span></div>
            </div>
          </div>
        </span></li>`,
    )
    .join("\n");

  const summaryRow = (label: string, amount: number) => `
        <li><span class="a-list-item">
          <div class="a-row od-line-item-row">
            <div class="a-column a-span7 od-line-item-row-label"><span class="a-size-base"><span>${label}</span></span></div>
            <div class="a-column a-span5 od-line-item-row-content a-span-last"><span class="a-size-base a-color-base">$${amount.toFixed(2)}</span></div>
          </div>
        </span></li>`;
  const grandTotalRow = `
        <li><span class="a-list-item">
          <div class="a-row od-line-item-row">
            <div class="a-column a-span7 od-line-item-row-label"><span class="a-size-base a-color-base a-text-bold"><span>Grand Total:</span></span></div>
            <div class="a-column a-span5 od-line-item-row-content a-span-last"><span class="a-size-base a-color-base a-text-bold">$${order.grandTotal.toFixed(2)}</span></div>
          </div>
        </span></li>`;

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Amazon.com - Order Details</title></head>
<body class="a-aui_29">
<div class="a-container" id="order-details-${pageIndex}">
  <div class="a-box-group a-spacing-base">
    <div class="a-box"><div class="a-box-inner">
      <div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner">
        <div class="a-fixed-right-grid-col a-col-left">
          <div class="a-row">
            <div class="a-column a-span3" data-component="orderDateLabel"><span>Order placed</span></div>
            <div class="a-column a-span3" data-component="orderDate"><span>${order.orderDateLabel}</span></div>
            <div class="a-column a-span3" data-component="orderIdLabel"><span>Order #</span></div>
            <div class="a-column a-span3" data-component="orderId"><span>${order.orderId}</span></div>
          </div>
          ${order.shipmentLabel ? `<div class="a-row" data-component="shipmentLabel"><span>${order.shipmentLabel}</span></div>` : ""}
        </div>
        <div class="a-fixed-right-grid-col a-col-right" data-component="orderInvoice">
          <a class="a-link-normal" href="${invoiceHref}">View invoice</a>
        </div>
      </div></div>
    </div></div>
  </div>

  <div class="a-box-group a-spacing-base" data-component="orderSummary">
    <div class="a-box"><div class="a-box-inner">
      <div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner">
        <div class="a-fixed-right-grid-col a-col-left">
          <div class="a-row">
            <div class="a-column a-span5" data-component="shippingAddress">
              <h5 class="a-spacing-micro">Ship to</h5>
              <ul class="a-unordered-list a-nostyle a-vertical">
                <li><span class="a-list-item">${order.shipName}</span></li>
                <li><span class="a-list-item">${order.shipStreet}<br>${order.shipCityStateZip}</span></li>
                <li><span class="a-list-item">United States</span></li>
              </ul>
            </div>
            <div class="a-column a-span7 a-span-last">
              <div data-component="viewPaymentPlanSummaryWidget">
                <h5 class="a-spacing-micro">Payment method</h5>
                <div class="a-section"><span>Visa ending in 4242</span></div>
              </div>
            </div>
          </div>
        </div>
      </div></div>
      <ul class="a-unordered-list a-nostyle a-vertical od-line-items">
${itemsHtml}
      </ul>
      <ul class="a-unordered-list a-nostyle a-vertical od-order-summary">
${summaryRow("Item(s) Subtotal:", order.subtotal)}
${summaryRow("Shipping &amp; Handling:", order.shipping)}
${summaryRow("Total before tax:", round2(order.subtotal + order.shipping))}
${summaryRow("Estimated tax to be collected:", order.tax)}
${grandTotalRow}
      </ul>
    </div></div>
  </div>
</div>
</body>
</html>`;
}

function renderOrderEmailHtml(order: {
  orderId: string;
  orderDateLabel: string;
  arrivingLabel: string;
  shipCity: string;
  items: { title: string; unitPrice: number }[];
  grandTotal: number;
}): string {
  const subjectTitle =
    order.items.length > 1
      ? `${order.items[0]!.title} and ${order.items.length - 1} more item${order.items.length > 2 ? "s" : ""}`
      : order.items[0]!.title;
  const itemRows = order.items
    .map(
      (item) => `
      <tr>
        <td><img src="${PLACEHOLDER_IMAGE}" alt="${item.title}" width="122"></td>
        <td><a href="https://www.amazon.example/gp/r.html?R=SYNTHETIC">${item.title}</a><br><span>$${item.unitPrice.toFixed(2)}</span></td>
      </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Gmail - Ordered: "${subjectTitle}"</title></head>
<body>
<div class="gmail-message">
  <table role="presentation">
    <tr><td><img src="${PLACEHOLDER_IMAGE}" alt="Gmail" class="logo"></td></tr>
  </table>
  <table role="presentation">
    <tr><td><b>Ordered: "${subjectTitle}"</b><br><font size="-1">1 message</font></td></tr>
  </table>
  <div class="order-confirmation">
    <div><span>${order.arrivingLabel}</span></div>
    <div><b>${order.shipCity}</b></div>
    <div><span>Order placed</span> <span>${order.orderDateLabel}</span></div>
    <div><span>Order #</span> <span>${order.orderId}</span></div>
    <table role="presentation">
${itemRows}
    </table>
    <table role="presentation">
      <tr><td align="left">Grand Total:</td><td align="right">$${order.grandTotal.toFixed(2)}</td></tr>
    </table>
  </div>
  <table role="presentation">
    <tr><td><img src="${PLACEHOLDER_IMAGE}" alt="Amazon.example" height="43" width="86"></td></tr>
  </table>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface ExpectedOrder {
  file: string;
  orderId: string;
  orderedAt: string;
  grandTotal: number;
  currency: "USD";
  items: { asin: string; title: string; unitPrice: number }[];
  /** Present only on an order-details entry whose order id has more than
   * one shipment, e.g. "Shipment 1 of 2". */
  shipmentLabel?: string | null;
}

export function buildRetailerCorpus(
  inputDir: string,
  outputDir: string,
): ExpectedOrder[] {
  mkdirSync(outputDir, { recursive: true });

  const files = readdirSync(inputDir).filter((name) => name.endsWith(".html"));
  const orderDetailFiles = files
    .filter((name) => name.startsWith("Order Details"))
    .sort((a, b) => a.localeCompare(b));
  const emailFiles = files
    .filter((name) => name.startsWith("Gmail - Ordered"))
    .sort((a, b) => a.localeCompare(b));

  const realOrders = orderDetailFiles.map((name) =>
    extractOrderDetails(readFileSync(path.join(inputDir, name), "utf8"), name),
  );
  const realEmails = emailFiles.map((name) =>
    extractOrderEmail(readFileSync(path.join(inputDir, name), "utf8"), name),
  );

  // Pass 1: compute a single date-shift offset so relative spacing between
  // real order dates is preserved across the whole corpus, and build
  // deterministic real->synthetic maps for order ids and ASINs shared
  // across every fixture (the same real order id or ASIN always maps to
  // the same synthetic value, matching how the real corpus reuses them).
  const realDates = realOrders
    .map((order) =>
      order.orderDateText ? new Date(order.orderDateText) : null,
    )
    .filter(
      (date): date is Date => date !== null && !Number.isNaN(date.getTime()),
    );
  const minRealDate = new Date(
    Math.min(...realDates.map((date) => date.getTime())),
  );
  const anchorSynthetic = new Date("2031-01-10T00:00:00.000Z");
  const offsetMs = anchorSynthetic.getTime() - minRealDate.getTime();

  const orderIdMap = new Map<string, string>();
  const asinMap = new Map<string, string>();
  let nextOrderIdIndex = 0;
  let nextAsinIndex = 0;
  const rng = seededRandom(42);

  const synthesizeOrderIdFor = (real: string | null): string => {
    const key = real ?? `unknown-${nextOrderIdIndex}`;
    if (!orderIdMap.has(key)) {
      orderIdMap.set(key, synthesizeOrderId(nextOrderIdIndex));
      nextOrderIdIndex += 1;
    }
    return orderIdMap.get(key)!;
  };
  const synthesizeAsinFor = (real: string): string => {
    if (!asinMap.has(real)) {
      asinMap.set(real, synthesizeAsin(nextAsinIndex));
      nextAsinIndex += 1;
    }
    return asinMap.get(real)!;
  };

  // A real ASIN always names the same product, so its synthetic title and
  // price are decided once (on first sight) and reused everywhere that ASIN
  // reappears — including across the two order-details pages of a
  // split-shipment order. Without this cache the same ASIN could render two
  // different product titles/prices depending only on which fixture wrote
  // it first, which is what produced order-details-3/4's mismatch before.
  const lineSynthCache = new Map<
    string,
    { title: string; unitPrice: number }
  >();

  // Precompute how many order-details fixtures share each synthetic order
  // id, so a split-shipment page can be labeled "Shipment N of M" as it is
  // rendered, and collect each order id's shipments so an email fixture for
  // that order id can be built from them (real date/lines/totals) instead
  // of re-deriving its own, which is what used to let an email disagree
  // with its order.
  const orderIdCounts = new Map<string, number>();
  for (const real of realOrders) {
    const id = synthesizeOrderIdFor(real.orderIdText);
    orderIdCounts.set(id, (orderIdCounts.get(id) ?? 0) + 1);
  }
  const ordersByOrderId = new Map<string, SyntheticOrder[]>();
  const shipmentIndexSoFar = new Map<string, number>();

  const expected: ExpectedOrder[] = [];
  let globalTitleIndex = 0;

  realOrders.forEach((real, index) => {
    const orderId = synthesizeOrderIdFor(real.orderIdText);
    const realDate = real.orderDateText
      ? new Date(real.orderDateText)
      : minRealDate;
    const syntheticDate = new Date(
      (Number.isNaN(realDate.getTime())
        ? minRealDate.getTime()
        : realDate.getTime()) + offsetMs,
    );

    const lines: SyntheticLine[] = real.items.map((item) => {
      const asin = synthesizeAsinFor(item.asin);
      const cached = lineSynthCache.get(asin);
      if (cached) return { asin, ...cached };
      const title = synthesizeProductTitle(item.title, globalTitleIndex);
      globalTitleIndex += 1;
      const basePrice = item.unitPrice ?? 20 + rng() * 40;
      const unitPrice = round2(Math.max(4.99, basePrice * PRICE_SCALE));
      lineSynthCache.set(asin, { title, unitPrice });
      return { asin, title, unitPrice };
    });

    const subtotal = round2(
      lines.reduce((sum, line) => sum + line.unitPrice, 0),
    );
    const shipping = 0;
    const tax = round2(subtotal * TAX_RATE);
    const grandTotal = round2(subtotal + shipping + tax);

    // A split shipment ships to the same address as the rest of its order,
    // so a later shipment reuses the first shipment's address rather than
    // deriving its own from its own array index.
    const existingShipments = ordersByOrderId.get(orderId) ?? [];
    const firstShipment = existingShipments[0];
    const cityIndex = index % SYNTHETIC_CITIES.length;
    const nameIndex = index % SYNTHETIC_FIRST_NAMES.length;
    const streetIndex = index % SYNTHETIC_STREETS.length;
    const { city, state, zip } = SYNTHETIC_CITIES[cityIndex]!;
    const shipName =
      firstShipment?.shipName ??
      `${SYNTHETIC_FIRST_NAMES[nameIndex]} ${SYNTHETIC_LAST_NAMES[nameIndex]}`;
    const shipStreet =
      firstShipment?.shipStreet ?? SYNTHETIC_STREETS[streetIndex]!;
    const shipCityStateZip =
      firstShipment?.shipCityStateZip ?? `${city}, ${state} ${zip}`;

    const shipmentTotal = orderIdCounts.get(orderId) ?? 1;
    const shipmentIndex = (shipmentIndexSoFar.get(orderId) ?? 0) + 1;
    shipmentIndexSoFar.set(orderId, shipmentIndex);
    const shipmentLabel =
      shipmentTotal > 1
        ? `Shipment ${shipmentIndex} of ${shipmentTotal}`
        : null;

    const order: SyntheticOrder = {
      orderId,
      orderedAt: syntheticDate.toISOString().slice(0, 10),
      orderDateLabel: formatAmazonDate(syntheticDate),
      lines,
      subtotal,
      shipping,
      tax,
      grandTotal,
      shipName,
      shipStreet,
      shipCityStateZip,
      shipmentLabel,
    };

    if (firstShipment && firstShipment.orderedAt !== order.orderedAt) {
      // A single real order is placed once; if its shipments' fixtures
      // disagree on the order date, the corpus's split-shipment invariant
      // (same order id => same order date) is broken and every downstream
      // email fixture for that order id would inherit an arbitrary date.
      throw new Error(
        `Order ${orderId} has shipments with different order dates ` +
          `(${firstShipment.orderedAt} vs ${order.orderedAt}); a split-shipment ` +
          "order must share one order date across its order-details fixtures.",
      );
    }
    existingShipments.push(order);
    ordersByOrderId.set(orderId, existingShipments);

    const outFile = `order-details-${index + 1}.html`;
    writeFileSync(
      path.join(outputDir, outFile),
      renderOrderDetailsHtml(order, index + 1),
    );
    expected.push({
      file: outFile,
      orderId: order.orderId,
      orderedAt: order.orderedAt,
      grandTotal: order.grandTotal,
      currency: "USD",
      items: order.lines.map((line) => ({
        asin: line.asin,
        title: line.title,
        unitPrice: line.unitPrice,
      })),
      shipmentLabel: order.shipmentLabel,
    });
  });

  realEmails.forEach((real, index) => {
    const orderId = synthesizeOrderIdFor(real.orderIdText);
    const shipments = ordersByOrderId.get(orderId);
    if (!shipments || shipments.length === 0) {
      // An email fixture with no matching order-details fixture has nothing
      // to stay consistent with, so it cannot be built from shared data.
      throw new Error(
        `order-email fixture ${real.sourceFile} has no matching order-details ` +
          `fixture for order id ${orderId}; every email in the corpus must pair ` +
          "with at least one order-details page.",
      );
    }
    const orderDateLabel = shipments[0]!.orderDateLabel;
    const orderedAt = shipments[0]!.orderedAt;
    const items = shipments.flatMap((shipment) => shipment.lines);
    const grandTotal = round2(
      shipments.reduce((sum, shipment) => sum + shipment.grandTotal, 0),
    );

    const cityIndex = index % SYNTHETIC_CITIES.length;
    const { city, state } = SYNTHETIC_CITIES[cityIndex]!;

    const html = renderOrderEmailHtml({
      orderId,
      orderDateLabel,
      arrivingLabel: "Arriving tomorrow",
      shipCity: `${SYNTHETIC_FIRST_NAMES[index % SYNTHETIC_FIRST_NAMES.length]} - ${city}, ${state}`,
      items: items.map((line) => ({
        title: line.title,
        unitPrice: line.unitPrice,
      })),
      grandTotal,
    });
    const outFile = `order-email-${index + 1}.html`;
    writeFileSync(path.join(outputDir, outFile), html);
    expected.push({
      file: outFile,
      orderId,
      orderedAt,
      grandTotal,
      currency: "USD",
      items: items.map((line) => ({
        asin: "N/A",
        title: line.title,
        unitPrice: line.unitPrice,
      })),
    });
  });

  writeFileSync(
    path.join(outputDir, "expected.json"),
    `${JSON.stringify(expected, null, 2)}\n`,
  );
  return expected;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  return process.argv[1] === new URL(import.meta.url).pathname;
}

if (isMainModule()) {
  const [inputDir, outputDir] = process.argv.slice(2);
  if (!inputDir || !outputDir) {
    console.error(
      "Usage: tsx tooling/build-retailer-corpus.ts <inputDir> <outputDir>",
    );
    process.exit(1);
  }
  const expected = buildRetailerCorpus(inputDir, outputDir);
  console.log(`Wrote ${expected.length} synthetic fixtures to ${outputDir}`);
}
