// Nx's self-hosted HTTP remote cache contract (the client is built into Nx and
// enabled by NX_SELF_HOSTED_REMOTE_CACHE_SERVER):
//   GET /v1/cache/{hash} -> 200 tarball | 404
//   PUT /v1/cache/{hash} -> 200 stored | 409 already stored
// Both require `Authorization: Bearer <NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN>`.
// A stored entry is never overwritten: a hash names one task result, and a
// stored passing result is what satisfies the merge gate.

interface Env {
  CACHE: R2Bucket;
  CACHE_TOKEN: string;
}

const encoder = new TextEncoder();

function authorized(request: Request, token: string): boolean {
  const supplied = encoder.encode(request.headers.get("authorization") ?? "");
  const expected = encoder.encode(`Bearer ${token}`);
  return (
    supplied.byteLength === expected.byteLength &&
    crypto.subtle.timingSafeEqual(supplied, expected)
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hash = /^\/v1\/cache\/([A-Za-z0-9]+)$/.exec(
      new URL(request.url).pathname,
    )?.[1];
    if (!hash) return new Response("not found", { status: 404 });
    if (!env.CACHE_TOKEN || !authorized(request, env.CACHE_TOKEN)) {
      return new Response("unauthorized", { status: 401 });
    }

    if (request.method === "GET") {
      const object = await env.CACHE.get(hash);
      if (!object) return new Response("not found", { status: 404 });
      return new Response(object.body, {
        headers: { "content-type": "application/octet-stream" },
      });
    }

    if (request.method === "PUT") {
      if (!request.body) return new Response("missing body", { status: 400 });
      // onlyIf rejects the write when an object already exists under the hash.
      const stored = await env.CACHE.put(hash, request.body, {
        onlyIf: { etagDoesNotMatch: "*" },
      });
      return stored
        ? new Response("stored")
        : new Response("exists", { status: 409 });
    }

    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, PUT" },
    });
  },
} satisfies ExportedHandler<Env>;
