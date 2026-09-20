export const INTERNAL_AGENT_PATH = "/internal/agents/purchase-import-run";
export const INTERNAL_AGENT_HEADER = "x-cubby-agent-service";
export const INTERNAL_AGENT_HEADER_VALUE = "purchase-import-proxy-v1";

export type InternalAgentRoute = { status: 403 | 404 } | { request: Request };

/** Authorization and prefix removal before the request reaches Flue's router. */
export function internalAgentRoute(request: Request): InternalAgentRoute {
  const url = new URL(request.url);
  if (
    url.pathname !== INTERNAL_AGENT_PATH &&
    !url.pathname.startsWith(`${INTERNAL_AGENT_PATH}/`)
  ) {
    return { status: 404 };
  }
  if (
    request.headers.get(INTERNAL_AGENT_HEADER) !== INTERNAL_AGENT_HEADER_VALUE
  ) {
    return { status: 403 };
  }
  url.pathname = url.pathname.slice(INTERNAL_AGENT_PATH.length) || "/";
  return { request: new Request(url, request) };
}
