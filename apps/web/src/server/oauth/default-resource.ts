import { z } from "zod";

import { MCP_RESOURCE } from "~/lib/auth-constants";

const tokenRequestBodySchema = z.record(z.string(), z.json());

export interface DefaultResourcePort {
  readonly resource: string;
}

const productionDefaultResourcePort: DefaultResourcePort = {
  resource: MCP_RESOURCE,
};

/**
 * Default the OAuth `resource` parameter on token requests.
 *
 * better-auth only mints a **JWT** access token when the request names a
 * `resource` (`isJwtAccessToken = audience && !disableJwtPlugin`); with no
 * resource it falls back to an opaque token stored in `oauth_access_token`.
 * Opaque tokens can only be validated by introspection, which requires a
 * confidential client and a network round trip per call — so /api/mcp accepts
 * JWTs only.
 *
 * claude.ai's connector completes the whole flow (register → consent → token)
 * without ever sending `resource`, and then fails on the first MCP call. Since
 * this server advertises exactly one resource in its RFC 9728 metadata, filling
 * it in when the client omits it is just applying the value the client should
 * have sent. An explicit `resource` from the client always wins, and anything
 * invalid still gets rejected against the plugin's persisted resource and
 * client-resource linkage.
 */
export async function withDefaultResource(
  request: Request,
  port: DefaultResourcePort = productionDefaultResourcePort,
): Promise<Request> {
  if (request.method !== "POST") return request;
  if (!new URL(request.url).pathname.endsWith("/oauth2/token")) return request;

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = new URLSearchParams(await request.text());
    if (body.has("resource")) return rebuild(request, body.toString());
    body.set("resource", port.resource);
    return rebuild(request, body.toString());
  }

  if (contentType.includes("application/json")) {
    const raw = await request.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return rebuild(request, raw); // let better-auth report the parse error
    }
    const parsed = tokenRequestBodySchema.safeParse(body);
    if (!parsed.success || Object.hasOwn(parsed.data, "resource")) {
      return rebuild(request, raw);
    }
    return rebuild(
      request,
      JSON.stringify({ ...parsed.data, resource: port.resource }),
    );
  }

  return request;
}

// A Request body can only be read once, so any inspected request has to be
// rebuilt before it reaches the auth handler — even when left unchanged.
function rebuild(request: Request, body: string): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
}
