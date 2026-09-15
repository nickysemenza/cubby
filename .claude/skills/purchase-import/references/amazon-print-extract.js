// Amazon printable-invoice extractor for the Chrome MCP `javascript_tool`.
//
// Run it on `https://www.amazon.com/gp/css/summary/print.html?orderID=<id>`.
// It rewrites the page body into one <pre> and returns the line count; read the
// result with `get_page_text` — the JS tool truncates its own return value at
// roughly 1,000 characters, and get_page_text does not. Do not `fetch()` order
// pages from inside the tool: a request carrying a query string is blocked, so
// paginate `/your-orders/orders?startIndex=N` with `navigate` instead.
//
// Output format (one line per item):
//   ASIN | qty | unit price | title | sold by | image id
// Image id maps to `https://m.media-amazon.com/images/I/<id>._SL1500_.jpg`,
// which Cubby's server can fetch directly via attach_files `url`.
//
// Quantity lives in `.od-item-view-qty` on Fresh / Whole Foods invoices and in
// the `N of:` / `Qty: N` text on ordinary ones. The price printed is the UNIT
// price; multiply by qty and assert the sum equals `Item(s) Subtotal` before
// booking anything.
//
// Known gaps this page has: a Whole Foods in-store (113-) trip omits the
// `Total Savings` line — read it from `/your-orders/order-details?orderID=`
// and book it as one order-level `discount` row; the print page then reports
// the pre-savings subtotal as Grand Total.
const rows = [];
const seen = new Set();
for (const a of document.querySelectorAll(
  'a[href*="/dp/"],a[href*="/gp/product/"]',
)) {
  const title = a.innerText.trim();
  if (!title) continue;
  const asin = (a.href.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1];
  let r = a;
  for (let i = 0; i < 10 && r; i++) {
    r = r.parentElement;
    if (r && /\$\d/.test(r.innerText) && r.querySelector("img")) break;
  }
  const t = r.innerText.replace(/\s+/g, " ");
  const key = asin + "|" + title;
  if (seen.has(key)) continue;
  seen.add(key);
  const qty =
    r.querySelector(".od-item-view-qty")?.innerText.trim() ||
    (t.match(/(\d+)\s+of:/) || t.match(/Qty:\s*(\d+)/) || [])[1] ||
    "1";
  const price = (t.match(/\$([\d,]+\.\d\d)/) || [])[1];
  const sold =
    (t.match(/Sold by:?\s*(.+?)(?:\s+(?:Supplied|Condition|Return|\$)|$)/) ||
      [])[1] || "";
  const img = r.querySelector("img")?.src || "";
  rows.push(
    [
      asin,
      qty,
      price,
      title,
      sold,
      img
        .replace(
          /^https:\/\/m\.media-amazon\.com\/images\/(?:W\/[^/]+\/images\/)?I\//,
          "",
        )
        .replace(/\._[^.]+_\./, "."),
    ].join(" | "),
  );
}
const bt = document.body.innerText;
const s = bt.indexOf("Order Summary", bt.indexOf("Order Summary") + 5);
const summary = bt
  .slice(s, bt.indexOf("Grand Total") + 40)
  .replace(/\n+/g, " ");
const pay = (bt.match(/Payment method\n([^\n]+)/) || [])[1];
const status =
  (bt.match(/(Delivered[^\n]*|Shipped[^\n]*|Arriving[^\n]*|Cancelled[^\n]*)/) ||
    [])[1] || "";
const pre = document.createElement("pre");
pre.textContent =
  "ORDER " +
  (bt.match(/Order # (\S+)/) || [])[1] +
  "\nPAY " +
  pay +
  "\n" +
  summary +
  "\nSTATUS " +
  status +
  "\nLINES\n" +
  rows.join("\n");
document.body.innerHTML = "";
document.body.appendChild(pre);
// The bare expression is the value the REPL-style javascript_tool returns.
// oxlint-disable-next-line no-unused-expressions
rows.length;
