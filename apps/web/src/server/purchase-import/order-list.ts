import type { BrowserCapture } from "@cubby/schemas/purchase-import";

type OrderListCandidate = {
  orderId: string;
  orderUrl: string | null;
  orderedAt: string | null;
};

export type OrderListClassification =
  | {
      kind: "order_list";
      orders: OrderListCandidate[];
      nextPageUrl: string | null;
    }
  | { kind: "order" }
  | { kind: "unknown" };

const AMAZON_ORDER_ID = /\b\d{3}-\d{7}-\d{7}\b/g;
// A generic order id only counts when it follows an explicit "Order" label,
// so bare ASIN-like tokens and prices in surrounding text never match. The
// label is matched case-insensitively but the id itself stays uppercase-only
// (no /i flag) so lowercase prose after "Order placed ..." can never be
// captured as an id.
const LABELLED_ORDER_ID =
  /\b[Oo]rder\s*(?:#|[Nn]umber)?\s*:?\s*#?\b([A-Z0-9]{6,20})\b/g;
const ORDER_ID_QUERY_KEYS = ["orderID", "orderId", "order_id"];
const HISTORY_URL_HINT = /order-history|\/orders\b/i;
const HISTORY_TEXT_HINT = /your orders|order history/i;
const NEXT_LINK_TEXT = /^\s*(next|older|more orders|›|→)/i;
const PAGE_QUERY_KEYS = ["startIndex", "page"];

const MONTH_NAMES =
  "January|February|March|April|May|June|July|August|September|October|November|December|" +
  "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const MONTH_AND_DAY_YEAR = new RegExp(
  `\\b(${MONTH_NAMES})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`,
  "gi",
);
const DAY_MONTH_YEAR = new RegExp(
  `\\b(\\d{1,2})\\s+(${MONTH_NAMES})\\s+(\\d{4})\\b`,
  "gi",
);
const ISO_YEAR_MONTH_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DATE_PATTERNS = [MONTH_AND_DAY_YEAR, DAY_MONTH_YEAR, ISO_YEAR_MONTH_DAY];

const MONTH_INDEX = new Map<string, number>([
  ["january", 1],
  ["jan", 1],
  ["february", 2],
  ["feb", 2],
  ["march", 3],
  ["mar", 3],
  ["april", 4],
  ["apr", 4],
  ["may", 5],
  ["june", 6],
  ["jun", 6],
  ["july", 7],
  ["jul", 7],
  ["august", 8],
  ["aug", 8],
  ["september", 9],
  ["sep", 9],
  ["sept", 9],
  ["october", 10],
  ["oct", 10],
  ["november", 11],
  ["nov", 11],
  ["december", 12],
  ["dec", 12],
]);

const pad2 = (value: number) => String(value).padStart(2, "0");

function formatDateMatch(
  pattern: RegExp,
  match: RegExpExecArray,
): string | null {
  if (pattern === ISO_YEAR_MONTH_DAY) {
    const [, year, month, day] = match;
    return `${year}-${month}-${day}`;
  }
  const isMonthFirst = Number.isNaN(Number(match[1]));
  const monthName = (isMonthFirst ? match[1] : match[2])?.toLowerCase();
  const day = isMonthFirst ? match[2] : match[1];
  const year = match[3];
  const month = monthName ? MONTH_INDEX.get(monthName) : undefined;
  if (!month || !day || !year) return null;
  return `${year}-${pad2(month)}-${pad2(Number(day))}`;
}

function allDateMatches(
  pattern: RegExp,
  snippet: string,
): { index: number; formatted: string }[] {
  pattern.lastIndex = 0;
  const matches: { index: number; formatted: string }[] = [];
  for (const match of snippet.matchAll(pattern)) {
    const formatted = formatDateMatch(pattern, match);
    if (formatted) matches.push({ index: match.index, formatted });
  }
  return matches;
}

// The nearest date to the id (not the first one in the window) is the order
// date, since a list page packs multiple "Order placed <date>" rows close
// together and an earlier row's date can otherwise leak into a later id.
function parseDateSnippet(snippet: string): string | null {
  const candidates = DATE_PATTERNS.flatMap((pattern) =>
    allDateMatches(pattern, snippet),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((closest, candidate) =>
    candidate.index > closest.index ? candidate : closest,
  ).formatted;
}

function hostMatches(hostname: string, allowedHosts: readonly string[]) {
  return allowedHosts.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
}

function parseUrl(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

function orderIdFromUrl(url: URL): string | null {
  for (const key of ORDER_ID_QUERY_KEYS) {
    const value = url.searchParams.get(key);
    if (value) return value;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  return segments.find((segment) => AMAZON_ORDER_ID.test(segment)) ?? null;
}

function collectIdsFromText(text: string): Map<string, number> {
  const positions = new Map<string, number>();
  for (const pattern of [AMAZON_ORDER_ID, LABELLED_ORDER_ID]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const id = match[1] ?? match[0];
      if (!positions.has(id)) positions.set(id, match.index);
    }
  }
  return positions;
}

function pageQueryValue(url: URL): number | null {
  for (const key of PAGE_QUERY_KEYS) {
    const raw = url.searchParams.get(key);
    if (raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/** Order ids found in `text`, plus (where an allowed-host link carries the same id) the link that points at each one. */
function collectOrderIds(
  capture: BrowserCapture,
  allowedHosts: readonly string[],
) {
  const idPositions = collectIdsFromText(capture.text);
  const idToUrl = new Map<string, string>();

  for (const link of capture.links) {
    const linkUrl = parseUrl(link.href);
    if (!linkUrl) continue;
    const id = orderIdFromUrl(linkUrl);
    if (!id) continue;
    if (!idPositions.has(id)) idPositions.set(id, -1);
    if (!idToUrl.has(id) && hostMatches(linkUrl.hostname, allowedHosts)) {
      idToUrl.set(id, link.href);
    }
  }
  return { idPositions, idToUrl };
}

function looksLikeHistoryPage(
  capture: BrowserCapture,
  currentUrl: URL | null,
): boolean {
  const titleAndLead = `${capture.title} ${capture.text.slice(0, 500)}`;
  return (
    (currentUrl !== null && HISTORY_URL_HINT.test(currentUrl.pathname)) ||
    HISTORY_URL_HINT.test(capture.title) ||
    HISTORY_TEXT_HINT.test(titleAndLead)
  );
}

function buildOrderList(
  distinctIds: string[],
  idPositions: Map<string, number>,
  idToUrl: Map<string, string>,
  text: string,
): OrderListCandidate[] {
  return distinctIds.map((orderId) => {
    const position = idPositions.get(orderId) ?? -1;
    const orderedAt =
      position >= 0
        ? parseDateSnippet(text.slice(Math.max(0, position - 200), position))
        : null;
    return { orderId, orderUrl: idToUrl.get(orderId) ?? null, orderedAt };
  });
}

function findNextPageUrl(
  capture: BrowserCapture,
  currentUrl: URL | null,
  allowedHosts: readonly string[],
): string | null {
  const currentPageValue = currentUrl ? pageQueryValue(currentUrl) : null;
  for (const link of capture.links) {
    const linkUrl = parseUrl(link.href);
    if (!linkUrl || !hostMatches(linkUrl.hostname, allowedHosts)) continue;
    if (NEXT_LINK_TEXT.test(link.text)) return link.href;
    const linkPageValue = pageQueryValue(linkUrl);
    if (
      linkPageValue !== null &&
      (currentPageValue === null || linkPageValue > currentPageValue)
    ) {
      return link.href;
    }
  }
  return null;
}

export function classifyOrderCapture(
  capture: BrowserCapture,
  options: { allowedHosts: readonly string[] },
): OrderListClassification {
  const currentUrl = parseUrl(capture.url);
  const urlOrderId = currentUrl ? orderIdFromUrl(currentUrl) : null;

  const { idPositions, idToUrl } = collectOrderIds(
    capture,
    options.allowedHosts,
  );
  if (urlOrderId)
    idPositions.set(urlOrderId, idPositions.get(urlOrderId) ?? -1);

  const distinctIds = [...idPositions.keys()];
  if (distinctIds.length === 0) return { kind: "unknown" };

  const isHistoryPage = looksLikeHistoryPage(capture, currentUrl);
  if (urlOrderId || (distinctIds.length === 1 && !isHistoryPage)) {
    return { kind: "order" };
  }

  // The only remaining cases (distinctIds.length is >=1 here, and the
  // single-id-and-not-history case returned above) are >=2 distinct ids, or
  // exactly 1 id on a page that looks like a history/list page.
  return {
    kind: "order_list",
    orders: buildOrderList(distinctIds, idPositions, idToUrl, capture.text),
    nextPageUrl: findNextPageUrl(capture, currentUrl, options.allowedHosts),
  };
}
