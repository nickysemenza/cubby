import { userId, type UserId } from "@cubby/schemas/identifiers";
import {
  DOMImplementation,
  DOMParser,
  XMLSerializer,
  type Document,
  type Element,
} from "@xmldom/xmldom";

import { parseCalDavEvent } from "./caldav-ics";
import {
  CALDAV_COLLECTIONS,
  CalDavError,
  type CalDavBackend,
  type CalDavCollection,
  type CalDavResource,
} from "./caldav-types";

const DAV = "DAV:";
const CALDAV = "urn:ietf:params:xml:ns:caldav";
const BASE = "/api/caldav";
// Calendar.app omits DELETE preconditions. Keep deletion in Cubby until a
// future protocol change explicitly chooses its stale-client semantics.
const METHODS = ["OPTIONS", "PROPFIND", "REPORT", "GET", "HEAD", "PUT"];
const ALLOW = METHODS.join(", ");
const XML_HEADERS = {
  "Content-Type": "application/xml; charset=utf-8",
  "Cache-Control": "no-store",
};
const dom = new DOMImplementation();
const serializer = new XMLSerializer();
type Property = { namespace: string; name: string };
type Selection = { mode: "all" | "names" | "selected"; properties: Property[] };
type Target =
  | { root: "base" | "principal" | "home" }
  | { root: "collection"; collection: CalDavCollection }
  | { root: "resource"; collection: CalDavCollection; filename: string };
type Props = (document: Document) => Element[];
const ALL: Selection = { mode: "all", properties: [] };
function element(
  document: Document,
  namespace: string,
  name: string,
  text?: string,
): Element {
  const node = document.createElementNS(namespace, name);
  if (text !== undefined) node.appendChild(document.createTextNode(text));
  return node;
}
function append(parent: Element, ...children: Element[]): Element {
  for (const child of children) parent.appendChild(child);
  return parent;
}
function documentRoot(document: Document): Element {
  if (!document.documentElement) throw new CalDavError(400, "Missing XML root");
  return document.documentElement;
}
function children(node: Element): Element[] {
  return Array.from(node.childNodes).filter(
    (child): child is Element => child.nodeType === 1,
  );
}
function is(node: Element, namespace: string, name: string): boolean {
  return node.namespaceURI === namespace && node.localName === name;
}
function xml(document: Document, status = 207): Response {
  return new Response(serializer.serializeToString(document), {
    status,
    headers: XML_HEADERS,
  });
}
function davError(status: number, tag: string, description: string): Response {
  const document = dom.createDocument(DAV, "D:error", null);
  const namespace = [
    "supported-filter",
    "valid-filter",
    "valid-calendar-data",
    "no-uid-conflict",
  ].includes(tag)
    ? CALDAV
    : DAV;
  append(
    documentRoot(document),
    element(document, namespace, `E:${tag}`),
    element(document, DAV, "D:responsedescription", description),
  );
  return xml(document, status);
}
function multistatus(entries: Element[]): Response {
  const document = dom.createDocument(DAV, "D:multistatus", null);
  for (const entry of entries)
    documentRoot(document).appendChild(document.importNode(entry, true));
  return xml(document);
}
function hrefFor(collection?: CalDavCollection, filename?: string): string {
  return collection
    ? `${BASE}/calendars/me/${collection}/${filename ? encodeURIComponent(filename) : ""}`
    : `${BASE}/`;
}
function statusResponse(href: string): Element {
  const document = dom.createDocument(DAV, "D:response", null);
  return append(
    documentRoot(document),
    element(document, DAV, "D:href", href),
    element(document, DAV, "D:status", "HTTP/1.1 404 Not Found"),
  );
}
function propResponse(
  href: string,
  props: Props,
  selection: Selection,
): Element {
  const document = dom.createDocument(DAV, "D:response", null);
  const root = append(
    documentRoot(document),
    element(document, DAV, "D:href", href),
  );
  const available = props(document);
  const known: Element[] = [];
  const unknown: Element[] = [];
  if (selection.mode === "selected") {
    for (const requested of selection.properties) {
      const found = available.find((node) =>
        is(node, requested.namespace, requested.name),
      );
      if (found) known.push(found);
      else unknown.push(element(document, requested.namespace, requested.name));
    }
  } else {
    for (const node of available)
      known.push(
        selection.mode === "names"
          ? element(document, node.namespaceURI ?? "", node.nodeName)
          : node,
      );
  }
  for (const [nodes, status] of [
    [known, "200 OK"],
    [unknown, "404 Not Found"],
  ] as const) {
    if (nodes.length)
      append(
        root,
        append(
          element(document, DAV, "D:propstat"),
          append(element(document, DAV, "D:prop"), ...nodes),
          element(document, DAV, "D:status", `HTTP/1.1 ${status}`),
        ),
      );
  }
  return root;
}
function collectionProps(collection: CalDavCollection): Props {
  return (document) => {
    const component = element(document, CALDAV, "C:comp");
    component.setAttribute("name", "VEVENT");
    const privilege = (name: string) =>
      append(
        element(document, DAV, "D:privilege"),
        element(document, DAV, `D:${name}`),
      );
    const report = (name: string) =>
      append(
        element(document, DAV, "D:supported-report"),
        append(
          element(document, DAV, "D:report"),
          element(document, CALDAV, `C:${name}`),
        ),
      );
    return [
      element(document, DAV, "D:displayname", CALDAV_COLLECTIONS[collection]),
      append(
        element(document, DAV, "D:resourcetype"),
        element(document, DAV, "D:collection"),
        element(document, CALDAV, "C:calendar"),
      ),
      append(
        element(document, CALDAV, "C:supported-calendar-component-set"),
        component,
      ),
      append(
        element(document, DAV, "D:current-user-privilege-set"),
        ...[
          "read",
          "write-content",
          "bind",
          ...(METHODS.includes("DELETE") ? ["unbind"] : []),
        ].map(privilege),
      ),
      append(
        element(document, DAV, "D:supported-report-set"),
        report("calendar-query"),
        report("calendar-multiget"),
      ),
    ];
  };
}
function resourceProps(resource: CalDavResource, calendarData = false): Props {
  return (document) => [
    element(document, DAV, "D:resourcetype"),
    element(document, DAV, "D:getcontenttype", "text/calendar; charset=utf-8"),
    element(document, DAV, "D:getetag", resource.etag),
    element(
      document,
      DAV,
      "D:getcontentlength",
      String(new TextEncoder().encode(resource.body).byteLength),
    ),
    ...(calendarData
      ? [element(document, CALDAV, "C:calendar-data", resource.body)]
      : []),
  ];
}
function principalProperties(document: Document): Element[] {
  const hrefProperty = (namespace: string, name: string, href: string) =>
    append(
      element(document, namespace, name),
      element(document, DAV, "D:href", href),
    );
  return [
    element(document, DAV, "D:displayname", "Cubby"),
    hrefProperty(DAV, "D:current-user-principal", `${BASE}/principals/me/`),
    hrefProperty(DAV, "D:principal-URL", `${BASE}/principals/me/`),
    hrefProperty(CALDAV, "C:calendar-home-set", `${BASE}/calendars/me/`),
  ];
}
function parseXml(body: string): Element {
  if (/<!DOCTYPE|<!ENTITY/i.test(body))
    throw new CalDavError(400, "DTD and entities are unsupported");
  let document: Document;
  try {
    document = new DOMParser({
      onError() {
        throw new Error("Malformed XML");
      },
    }).parseFromString(body, "application/xml");
  } catch {
    throw new CalDavError(400, "Malformed XML");
  }
  const root = documentRoot(document);
  const stack = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    count += current.node.childNodes.length + 1;
    if (count > 10_000 || current.depth > 32)
      throw new CalDavError(400, "XML exceeds complexity limit");
    stack.push(
      ...children(current.node).map((node) => ({
        node,
        depth: current.depth + 1,
      })),
    );
  }
  return root;
}
function selectProperties(root: Element): Selection {
  const selectors = children(root).filter(
    (node) =>
      node.namespaceURI === DAV &&
      ["prop", "allprop", "propname"].includes(node.localName ?? ""),
  );
  if (!selectors.length) return ALL;
  if (selectors.length !== 1)
    throw new CalDavError(400, "Expected one property selector");
  const selector = selectors[0];
  if (!selector) throw new CalDavError(400, "Missing property selector");
  if (is(selector, DAV, "allprop")) return ALL;
  if (is(selector, DAV, "propname")) return { mode: "names", properties: [] };
  const properties = children(selector).map((node) => {
    if (
      children(node).length ||
      Array.from(node.attributes).some(
        (attribute) =>
          attribute.namespaceURI !== "http://www.w3.org/2000/xmlns/",
      )
    )
      throw new CalDavError(
        403,
        "Property transformations are unsupported",
        "supported-filter",
      );
    return {
      namespace: node.namespaceURI ?? "",
      name: node.localName ?? node.nodeName,
    };
  });
  return { mode: "selected", properties };
}
function parseDate(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!/^\d{8}T\d{6}Z$/.test(value))
    throw new CalDavError(
      400,
      "Time range requires UTC timestamps",
      "valid-filter",
    );
  const date = new Date(
    value.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      "$1-$2-$3T$4:$5:$6.000Z",
    ),
  );
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().replace(/[-:]/g, "").replace(".000", "") !== value
  )
    throw new CalDavError(400, "Invalid time range", "valid-filter");
  return date.toISOString();
}
function onlyElement(nodes: Element[]): Element {
  const node = nodes[0];
  if (nodes.length !== 1 || !node)
    throw new CalDavError(
      403,
      "Expected one filter component",
      "supported-filter",
    );
  return node;
}
function filterAttributes(node: Element, supported: string[]): void {
  for (const attribute of Array.from(node.attributes)) {
    if (attribute.namespaceURI === "http://www.w3.org/2000/xmlns/") continue;
    if (attribute.namespaceURI || !supported.includes(attribute.name))
      throw new CalDavError(
        403,
        "Unsupported filter attribute",
        "supported-filter",
      );
  }
}
function componentFilter(parent: Element, name: string): Element {
  const node = onlyElement(children(parent));
  filterAttributes(node, ["name"]);
  if (!is(node, CALDAV, "comp-filter") || node.getAttribute("name") !== name)
    throw new CalDavError(403, `Expected ${name} filter`, "supported-filter");
  return node;
}
function queryRange(
  root: Element,
): { start?: string; end?: string } | undefined {
  const filter = onlyElement(
    children(root).filter((node) => is(node, CALDAV, "filter")),
  );
  filterAttributes(filter, []);
  const calendar = componentFilter(filter, "VCALENDAR");
  const event = componentFilter(calendar, "VEVENT");
  const ranges = children(event);
  if (!ranges.length) return undefined;
  const range = onlyElement(ranges);
  if (!is(range, CALDAV, "time-range") || children(range).length)
    throw new CalDavError(
      403,
      "Only event time ranges are supported",
      "supported-filter",
    );
  filterAttributes(range, ["start", "end"]);
  const start = parseDate(range.getAttribute("start"));
  const end = parseDate(range.getAttribute("end"));
  if ((!start && !end) || (start && end && start >= end))
    throw new CalDavError(400, "Invalid time range", "valid-filter");
  return { start, end };
}
function path(url: URL): Target | null {
  const suffix =
    url.pathname.startsWith(`${BASE}/`) || url.pathname === BASE
      ? url.pathname.slice(BASE.length).replace(/\/+$/, "") || "/"
      : null;
  if (suffix === "/") return { root: "base" };
  if (suffix === "/principals/me") return { root: "principal" };
  if (suffix === "/calendars/me") return { root: "home" };
  if (suffix === null) return null;
  const match =
    /^\/calendars\/me\/(tasks|completed-tasks|meals)(?:\/([^/]+))?$/.exec(
      suffix,
    );
  if (!match) return null;
  const collection = match[1];
  if (
    collection !== "tasks" &&
    collection !== "completed-tasks" &&
    collection !== "meals"
  )
    return null;
  if (!match[2]) return { root: "collection", collection };
  const filename = decodeURIComponent(match[2]);
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    Array.from(filename).some((character) => character.charCodeAt(0) < 32) ||
    filename.length > 255
  )
    throw new CalDavError(400, "Invalid resource filename");
  return { collection, filename, root: "resource" };
}
function matched(ifNoneMatch: string | null, etag: string): boolean {
  return (
    ifNoneMatch
      ?.split(",")
      .some(
        (value) =>
          value.trim() === "*" ||
          value.trim() === etag ||
          value.trim() === `W/${etag}`,
      ) ?? false
  );
}
async function requestBody(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length") ?? 0) > 1_000_000)
    throw new CalDavError(413, "Payload too large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 1_000_000) {
        await reader.cancel();
        throw new CalDavError(413, "Payload too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw new CalDavError(400, "Invalid UTF-8");
  }
}
async function propfind(
  request: Request,
  target: Target,
  backend: CalDavBackend,
): Promise<Response> {
  const depth = request.headers.get("depth") ?? "infinity";
  if (depth !== "0" && depth !== "1")
    throw new CalDavError(
      403,
      "Only depth 0 and 1 are supported",
      "propfind-finite-depth",
    );
  const body = await requestBody(request);
  const root = body.trim() ? parseXml(body) : null;
  if (
    root &&
    (!is(root, DAV, "propfind") ||
      children(root).some(
        (node) =>
          node.namespaceURI !== DAV ||
          !["prop", "allprop", "propname"].includes(node.localName ?? ""),
      ))
  )
    throw new CalDavError(400, "Invalid PROPFIND");
  const selection = root ? selectProperties(root) : ALL;
  const entry = (href: string, props: Props) =>
    propResponse(href, props, selection);
  switch (target.root) {
    case "base":
      return multistatus([
        entry(hrefFor(), (document) => [
          append(
            element(document, DAV, "D:resourcetype"),
            element(document, DAV, "D:collection"),
          ),
          // Calendar.app requests home discovery directly on the account URL.
          ...principalProperties(document),
        ]),
      ]);
    case "principal":
      return multistatus([
        entry(`${BASE}/principals/me/`, (document) => [
          ...principalProperties(document),
          append(
            element(document, DAV, "D:resourcetype"),
            element(document, DAV, "D:principal"),
          ),
        ]),
      ]);
    case "home":
      return multistatus([
        entry(`${BASE}/calendars/me/`, (document) => [
          append(
            element(document, DAV, "D:resourcetype"),
            element(document, DAV, "D:collection"),
          ),
        ]),
        ...(depth === "1"
          ? Object.keys(CALDAV_COLLECTIONS).flatMap((collection) =>
              collection === "tasks" ||
              collection === "completed-tasks" ||
              collection === "meals"
                ? [entry(hrefFor(collection), collectionProps(collection))]
                : [],
            )
          : []),
      ]);
    case "collection":
      return multistatus([
        entry(hrefFor(target.collection), collectionProps(target.collection)),
        ...(depth === "1"
          ? backend
              .list(target.collection)
              .map((resource) =>
                entry(
                  hrefFor(target.collection, resource.filename),
                  resourceProps(resource),
                ),
              )
          : []),
      ]);
    case "resource": {
      const resource = backend.get(target.collection, target.filename);
      if (!resource) throw new CalDavError(404, "Resource does not exist");
      return multistatus([
        entry(
          hrefFor(target.collection, target.filename),
          resourceProps(resource),
        ),
      ]);
    }
  }
}
async function report(
  request: Request,
  target: Target,
  backend: CalDavBackend,
): Promise<Response> {
  if (target.root !== "collection")
    throw new CalDavError(
      400,
      "REPORT requires a calendar collection",
      "supported-report",
    );
  const root = parseXml(await requestBody(request));
  const query = is(root, CALDAV, "calendar-query");
  if (!query && !is(root, CALDAV, "calendar-multiget"))
    throw new CalDavError(403, "Unsupported report", "supported-report");
  const allowed = (node: Element) =>
    is(node, DAV, "prop") ||
    (query ? is(node, CALDAV, "filter") : is(node, DAV, "href"));
  if (children(root).some((node) => !allowed(node)))
    throw new CalDavError(
      403,
      "Unsupported report filter or timezone",
      "supported-filter",
    );
  const selection = selectProperties(root);
  const entry = (resource: CalDavResource) =>
    propResponse(
      hrefFor(target.collection, resource.filename),
      resourceProps(resource, true),
      selection,
    );
  if (query)
    return multistatus(
      backend.list(target.collection, queryRange(root)).map(entry),
    );
  const hrefs = children(root).filter((node) => is(node, DAV, "href"));
  if (!hrefs.length)
    throw new CalDavError(400, "Multiget requires resource hrefs");
  return multistatus(
    hrefs.map((node) => {
      const href = node.textContent?.trim() ?? "";
      const url = new URL(href, request.url);
      const candidate = path(url);
      if (
        url.origin !== new URL(request.url).origin ||
        candidate?.root !== "resource" ||
        candidate.collection !== target.collection
      )
        return statusResponse(href);
      const resource = backend.get(candidate.collection, candidate.filename);
      return resource ? entry(resource) : statusResponse(href);
    }),
  );
}
function read(
  request: Request,
  target: Target,
  backend: CalDavBackend,
): Response {
  if (target.root !== "resource") throw new CalDavError(404, "Not found");
  const resource = backend.get(target.collection, target.filename);
  if (!resource) throw new CalDavError(404, "Not found");
  const headers = {
    "Content-Type": "text/calendar; charset=utf-8",
    ETag: resource.etag,
    "Cache-Control": "private, no-cache",
  };
  if (matched(request.headers.get("if-none-match"), resource.etag))
    return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : resource.body, {
    headers,
  });
}
async function write(
  request: Request,
  target: Target,
  backend: CalDavBackend,
  actorId: UserId,
): Promise<Response> {
  if (target.root !== "resource" || !target.filename.endsWith(".ics"))
    throw new CalDavError(409, "Write requires an .ics resource path");
  const body = request.method === "PUT" ? await requestBody(request) : null;
  let event = null;
  if (body !== null) {
    try {
      event = parseCalDavEvent(body, target.collection);
    } catch (error) {
      throw new CalDavError(
        400,
        error instanceof Error ? error.message : "Invalid event",
        "valid-calendar-data",
      );
    }
  }
  const result = await backend.write({
    actorId,
    collection: target.collection,
    filename: target.filename,
    event,
    ifMatch: request.headers.get("if-match"),
    ifNoneMatch: request.headers.get("if-none-match"),
    body,
  });
  return new Response(null, {
    status: result.status,
    headers: result.etag ? { ETag: result.etag } : undefined,
  });
}
/** The backend is DO-only; reads never open PostgreSQL. */
export function createCalDavHandler(
  backend: CalDavBackend,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (url.protocol !== "https:")
        throw new CalDavError(400, "HTTPS is required");
      if (
        url.pathname === "/.well-known/caldav" ||
        url.pathname === "/.well-known/caldav/"
      )
        return Response.redirect(new URL(`${BASE}/`, url.origin), 308);
      const target = path(url);
      if (!target) throw new CalDavError(404, "Not found");
      if (request.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            DAV: "1, calendar-access",
            Allow: ALLOW,
            "MS-Author-Via": "DAV",
          },
        });
      const actorId = await backend.authenticate(
        request.headers.get("authorization"),
      );
      if (!actorId)
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Cubby Calendar"',
            "Cache-Control": "no-store",
          },
        });
      if (!METHODS.includes(request.method))
        return new Response(
          request.method === "DELETE"
            ? "Delete events in Cubby."
            : "Method not allowed",
          {
            status: 405,
            headers: { Allow: ALLOW },
          },
        );
      if (!backend.ready())
        return new Response("Calendar is initializing", {
          status: 503,
          headers: { "Retry-After": "30" },
        });
      switch (request.method) {
        case "PROPFIND":
          return await propfind(request, target, backend);
        case "REPORT":
          return await report(request, target, backend);
        case "GET":
        case "HEAD":
          return read(request, target, backend);
        case "PUT":
        case "DELETE":
          return await write(request, target, backend, userId.parse(actorId));
        default:
          return new Response("Method not allowed", {
            status: 405,
            headers: { Allow: ALLOW },
          });
      }
    } catch (error) {
      if (error instanceof CalDavError)
        return davError(
          error.status,
          error.condition ?? "conflict",
          error.message,
        );
      return new Response("Calendar temporarily unavailable", {
        status: 503,
        headers: { "Retry-After": "30" },
      });
    }
  };
}
