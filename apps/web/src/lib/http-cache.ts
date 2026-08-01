const HTML_CACHE_CONTROL = "private, no-cache, must-revalidate";

/** Force every SSR HTML document to revalidate while preserving its stream. */
export function withHtmlNoCache(response: Response): Response {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!contentType?.startsWith("text/html")) return response;

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", HTML_CACHE_CONTROL);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
