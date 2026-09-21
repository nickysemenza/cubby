# Enrichment sources and traps

What actually works per source, and the placeholder and wrong-variant shapes
that pass a naive check. Read the section for the source in hand; do not read
the whole file.

## General

- **Gate every image on both dimensions ≥ 200 px AND ≥ 2,000 bytes**, then
  `verify_products_images`. Real placeholders seen: a 43-byte 1×1 GIF (legacy
  Amazon endpoint), a 60×40 "no image available" GIF, 988×87 / 803×127 banner
  strips (pass a width check), Newegg's 300×146 `not-available` graphic, and a
  shared 1×1 GIF that Whole Foods serves for unphotographed items. Treat the
  floor as a heuristic — a real 186×282 book cover at 19 KB is fine.
- **`verify_product_images` never decodes the bytes.** It checks R2 existence
  and metadata, so a corrupt or fully transparent file passes as verified. When
  correctness matters, download the stored file and look at it. A subagent
  citing the verify tool is not proof.
- **The tell for a wrong-variant image is cross-category nonsense at a
  believable size** — a tool wearing an accessory's photo. No mechanical gate
  catches it; only looking does.
- **Retailer titles become product names, and they lie.** Two "wrong image"
  findings were wrong *names* with correct photos (a roller stand sold as an
  "Adjustable Steel Saw Horse"; a colour lifted from a sibling listing). Check
  whether the name is what is wrong before replacing an image; keep the retailer
  title as an alias so receipt-side searches still hit.
- A listing title's trailing code is often a URL-slug artifact; the page's own
  "SKU / Manufacturer's Part" line is authoritative. A title that *omits* a
  designation is not evidence the designation is wrong.
- **Check the reseller before concluding the maker dropped a product** — Apple
  still listed an accessory Anker had removed, with the full Manufacturer
  Information block.
- A cover sweep answers other open questions as a side effect (image filenames
  encode the maker; notes saying "manufacturer pending a vendor-page check" get
  closed). Read the notes for what else the lookup would answer.
- **An attachment URL fetch is not your browser.** A URL that loads for you
  can 403 the server (kitchenaid.com's image CDN); stage local bytes with
  `create_file_uploads({items})` and attach its indexed `uploadId` result.
  Conversely `m.media-amazon.com`, `ikea.com`,
  `mobileimages.lowes.com`, `images.thdstatic.com`, Zoro's `og:image` and Shopify
  CDNs all fetch server-side fine.
- **`entity merge product` carries fields.** The survivor's empty `upc`,
  `price` and `expectedQuantity` are filled from the loser, and the loser's
  image can take cover — so folding a scan-created duplicate onto a clean
  record installs the catalog price as an override that beats the
  Expense-derived value. Check `pricing.source` and the cover after every merge.
  Merge dedupes images by id, not content hash, so byte-identical files both
  survive; check the product's gallery, not `Image.targetId`. A colliding
  `(source, kind)` external id on the loser is discarded — note it in the
  survivor if worth keeping.
- **Scan-created Products copy the UPC provider's name, manufacturer and price
  verbatim**, and that price is often the multipack/case listing (5.7× on a foam
  brush, 2.6× on a spray can); it is not uniformly high, so verify per item
  rather than blanket-clearing. The name is often a retailer SEO title too.
- Only a stocked Product raises the `product_image` gap, so an unstocked
  imageless product is not a worklist item and cannot carry an exception. Most
  stocked imageless products are hand-inventory `misc:` bin rows describing a
  bin's contents — there is no correct image for those; a stock photo would be
  fabrication.
- Run parallel enrichment agents on disjoint vendor sets, each with its own
  browser tab id, and verify every agent's writes with SQL afterwards. Prompt
  them to skip when they cannot verify: a wrong image is worse than no image.

## Amazon

- `amazon.com/dp/<ASIN>` 403/500s the server; use the signed-in browser.
  Same-origin `fetch()` from an open Amazon tab pulls many ASINs per call;
  extract `"hiRes"`. Expect hard 404s on 2015–2020 purchases (delisted,
  permanent).
- **CDN rule:** `m.media-amazon.com/images/I/...` is fine (banning it blocks every
  Amazon-owned brand and Whole Foods); `images-na.ssl-images-amazon.com/images/P/<ASIN>`
  returns HTTP 200 with a 43-byte GIF for most items.
- **Three ways an ASIN stops naming your product**, all yielding a
  confidently-wrong image that passes every gate:
  1. *Variation family.* The ASIN is a child; `/dp/<ASIN>` renders the family's
     default child. Pin with `?th=1` (and `&psc=1`), re-read the title/swatch
     before taking `#landingImage`. Re-enrichment is not idempotent otherwise.
  2. *Dead child ASIN redirects to a live sibling.* Amazon does not 404 a retired
     child; it 302s to a sibling variant and the served page looks normal —
     title, canonical, `currentAsin` and the detail table all read the sibling.
     **Always assert the served ASIN equals the requested one** (`location.href`,
     `link[rel=canonical]`, the `"currentAsin"` in the HTML). Do not "repair" the
     stored ASIN to the redirect target — unknown beats confidently wrong. A
     `dimensionValuesDisplayData` list omitting the requested ASIN is a symptom,
     not proof the variant never existed. Roughly half of redirects are harmless
     (a different size of the same colourway).
  3. *ASIN reassigned* to an unrelated listing after delisting, or regional
     surfaces disagreeing (`.ca`/`.es` may still serve the original child). When
     surfaces disagree and neither matches the record, stop re-enriching from it.
- Amazon's own order pages are the ground truth for what an ASIN *was*; the
  "Purchased another variation N times" banner fingerprints the family trap.
- Symptom sweep that works without probing Amazon: compare each stored image's
  dominant colour (corner-patch background sampling) to the colour word in the
  name, dropping food, treating compound colours as their base. Expect mostly
  false positives — white-on-white products, colour words describing contents
  ("Green Lumber", "Black Beans"), vivid packaging — and a handful of real
  defects.
- **Grocery → `wholefoodsmarket.com/product/dp/<ASIN>`**: one fetch, no search,
  and loose produce and raw meat usually have an Amazon Fresh package photo.
  Books → Open Library by ISBN (watch for undersized thumbnails).
- **Grocery detail bullets carry a `UPC` row** (`#detailBullets_feature_div`
  / `#prodDetails`). It is seller-supplied: corroborate with `lookup_upc`
  (a USDA branded hit under the right brand owner is proof) or the barcode on
  the back-of-bag gallery image. `Item model number` on grocery is the UPC
  again or junk (`Ad-bm6-8005`) — never copy it to `model`.
- **The back-of-bag gallery image is the nutrition label.** `curl` the
  `hiRes` URLs (`m.media-amazon.com`, server-fetchable) and read the images:
  one of them has the Nutrition Facts panel and the printed barcode. Transcribe
  it into `labelNutrition` (`servingGrams` from "Serving size (140g)") only
  when USDA has no record for the exact product.

## Home Depot

- `homedepot.com` 403s the server and curl; use the browser. `homedepot.com/s/<MODEL>`
  redirects straight to the product page on an exact model match (and
  `/s/<upc>` on a UPC); otherwise scroll the lazy results grid before reading
  links — the ones readable before scrolling are typeahead recommendations.
  ~40 rapid loads trips a session-scoped error page; open a fresh tab on the
  home page to reset.
- A product page's header exposes `Internet # / Model # / UPC Code # / Store
  SKU #` in one line; the cover is the `…-64_600.jpg` variant (`64_1000` for
  full size — verify it loads). Read `new URL(src).origin + pathname` — the
  browser tool redacts URLs carrying query strings. Read a price from a
  screenshot, not page text: a half-hydrated page renders a promo banner where
  the price will be.
- A kit's per-component models sit in the served markup even while the Product
  Details accordion is collapsed:
  `document.documentElement.innerHTML.match(/Includes[^<"]{0,400}/gi)`; filter
  out `Array.includes(` hits. HD publishes no model for a bundled charger.
- **RYOBI is HD-exclusive**: `ryobitools.com` product ids are HD internet
  numbers, and the ryobitools URL's numeric segment is the UPC minus its leading
  zero — pad to 12 digits. Covers live on Shopify CDN (`_2000x2000.jpg`; strip
  width/height/crop params). Bare-tool and kit SKUs have separate pages and
  UPCs; outlet `VN`/`VNM` variants have none; ended eBay listings expose no MPN
  or barcode.
- Kit-packed tools are the non-`B` model; the standalone retail SKU is the `B`
  variant — use it for image and HD identifiers, keep the kit's model, and do
  not copy its UPC.
- Garden-center nursery SKUs (plants, herbs) return zero results online — local
  store stock with no listing; leave them imageless with a note.
- Milwaukee near-identical models (PACKOUT wall plates one digit apart) are
  distinct products; HD import titles often omit "PACKOUT". Search by
  `modelFilter`.

## Lowe's

- Served to the in-app browser without bot-blocking; `lowes.com/search?searchTerm=<item#>`
  302s to the product page when the SKU is live. **Guard on `Item #<n>`
  appearing in the page text** — a results page will offer a same-spec
  different SKU. Delisted SKUs often still have a live page by direct URL.
- Batch ~8–10 same-origin `fetch()` + `DOMParser` lookups per call and space
  them: **the rate limit is per browser** — the in-app browser locks out for the
  session after ~16 fetches; Claude-in-Chrome on the same machine was never
  blocked, so use Chrome first for Lowe's. The image CDN keeps serving after a
  block, so capture every ld+json `contentUrl` (the `ImageObject` with
  `representativeOfPage: true`; drop `?size=`) in the first sweep.
- Plant/soil/garden pages carry no ld+json; their image `alt` embeds the model
  or item number and needs a real navigate + ~4 s wait (fetch returns
  pre-render HTML). Proximity to `"itemNumber":"<n>"` in embedded JSON is a last
  resort that can capture a **neighbour** — corroborate with a page title,
  model or UPC prefix. A sibling SKU with adjacent item numbers can rescue an
  unverifiable one.
- Regex `Model\s*#\s*(\S+)` grabs the next word (`…Best`, `…Shop`); strip it.
- Blue Hawk → Project Source in place under the same item number; house brands
  exist nowhere else. Home Depot is the fallback for national brands only.

## Costco

Two identifiers (`item_number` from the header, `catalog_number` from the URL);
model and specs behind the **Specifications** tab (click, wait, re-read;
multi-colour items list a model per variant); images are AVIF, which
the attachment workflow rejects — swap the AEM URL's extension to `.jpg`. `_1` is usually
the clean hero.

## Zoro

`zoro.com/i/<ZORO#>/` resolves to the canonical slug; every page carries JSON-LD
with `sku`, `mpn`, `brand.name`, `gtin12`, `offers.price`, and a
server-fetchable `og:image` (450×450). `fetch()` in-page follows the redirect, so
several SKUs resolve in one call. Mfr # → Zoro # is ambiguous (several live
listings per model); only Zoro # → Mfr # is safe.

## Shopify stores and their emails

Order-confirmation emails embed `_compact_cropped` thumbnails (~3 KB); strip
that suffix from the filename for the full-size original, and `curl -I` both
before attaching — the base name is not guaranteed. Drop the `?v=` query (the
Gmail tool mangles it); extensions lie (`.webp` serving `image/jpeg` is fine,
the attachment workflow sniffs). The filename often encodes the maker SKU — a hint, never
a `model` value. A store's `/products.json?limit=250` is the whole catalog with
per-variant `featured_image`; parse it in the in-app browser (Chrome's JSON
viewer mangles `innerText`).

## IKEA

Article numbers from product-page links (`/p/<slug>-<8 digits>/`, split 3-3-2);
colour/variant from image filenames, often the only carrier on in-store
receipts; `?f=xl` for a larger image. Old articles lose their links but keep
their images.

## Weee!, Safeway, Penn State, Woodworker Express, Apple

- **Weee!**: order-page images hydrate late (`[data-testid="wid-order-detail-product-image"]`
  after ~2.5 s; strip from `!` in the `src`); the public search
  (`weee.com/en/search?keyword=`) gives the same CDN image and the numeric
  product id in the href without login. Use a `computer wait` between navigate
  and script rather than `await` sleeps.
- **Safeway**: BPN from `<img>` alt on the order page; JSON-LD `gtin13` is UPC-A
  minus its check digit, zero-padded (recompute); images at
  `images.albertsons-media.com/is/image/ABS/{bpn}?wid=800&hei=800&fmt=jpeg`.
- **Penn State Industries**: product page `og:image` (may sit in a numbered
  subdirectory — read the tag); `javascript_tool` is blocked on their
  query-string pages, `get_page_text` works, plain curl with a browser UA works.
- **Woodworker Express**: `search.php?mode=search&substring=<SKU>` resolves by
  retailer SKU (it is X-Cart; `/catalogsearch/` 404s). The page's "Manufacturer's
  Part" line is authoritative over the title's trailing code.
- **Apple**: `support.apple.com` identifier pages give A-numbers (devices, US
  variant), Model Identifiers (configure-to-order Macs) and `Mxxxx/A` part
  numbers (accessories; prefer these for AirPods). Part numbers are per colour
  and the store page defaults to one — select the swatch first. The store CDN
  binds its resize token to the requested size, so use the rendered size.
  Retired accessories have no manufacturer page and Amazon results are
  third-party lookalikes.

## Sources that cannot supply a cover

- **McMaster-Carr** renders (after ~16 s, not 3) but draws the product hero on a
  **canvas** with no fetchable image URL. **Sherwin-Williams** likewise.
- **Discount Dimmers** "product photos" are ~288-byte flat colour swatches.
- **Bay Metals, Gow Supply, Moore Newton** have no e-commerce catalog — house
  SKUs for cut-to-length stock. Permanent.
- A vendor that sells one item only as a multipack cannot supply a single-unit
  cover; record the sharpened identity from the listing text and leave the
  gallery empty.
- Acme Tools throws a PerimeterX "Press & Hold" after one or two loads; solving
  it is off-limits. Milwaukee and Festool sites are curl-friendly (Milwaukee's
  srcset publishes `mw=2800`; no UPC).

Confirmed good manufacturer sources: nikonusa, dewalt, milwaukeetool, rode,
gerbergear, kleintools, madeincookware, peakdesign, lululemon, lenovo,
`store.bblcdn.com` for Bambu.
