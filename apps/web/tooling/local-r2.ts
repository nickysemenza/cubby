import type { R2Bucket } from "@cloudflare/workers-types";

export type LocalStorageEnv = Pick<Env, "R2_BUCKET_NAME" | "R2_KEY_PREFIX"> & {
  LOCAL_DEV_STORAGE: R2Bucket;
};

const s3Prefix = "/__local-storage/s3/";
const transformPrefix = "/cdn-cgi/image/";
const methods = "GET, HEAD, PUT, DELETE, OPTIONS";

function response(
  body: BodyInit | null,
  status: number,
  headers = new Headers(),
) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", methods);
  headers.set("Access-Control-Allow-Headers", "*, Authorization");
  headers.set(
    "Access-Control-Expose-Headers",
    "ETag, Content-Length, Content-Range, Accept-Ranges, Content-Disposition",
  );
  return new Response(body, { status, headers });
}

function byteRange(value: string, size: number) {
  const parts = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!parts || size === 0) return null;
  const startText = parts[1] ?? "";
  const endText = parts[2] ?? "";
  if (!startText && !endText) return null;
  const start = startText
    ? Number(startText)
    : Math.max(0, size - Number(endText));
  const end =
    startText && endText ? Math.min(Number(endText), size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    (!startText && Number(endText) <= 0) ||
    start >= size ||
    start > end
  )
    return null;
  return { offset: start, length: end - start + 1 };
}

function storageRoute(request: Request, env: LocalStorageEnv) {
  let pathname = new URL(request.url).pathname;
  if (pathname.startsWith(transformPrefix)) {
    const originalPath = pathname.indexOf("/", transformPrefix.length);
    if (originalPath === -1) return response(null, 404);
    pathname = pathname.slice(originalPath);
  }
  const s3 = pathname.startsWith(s3Prefix);
  let encodedKey: string;
  if (s3) {
    const objectPath = pathname.slice(s3Prefix.length);
    const separator = objectPath.indexOf("/");
    if (
      separator < 0 ||
      objectPath.slice(0, separator) !== env.R2_BUCKET_NAME
    ) {
      return response(null, 404);
    }
    encodedKey = objectPath.slice(separator + 1);
  } else {
    if (!pathname.startsWith(`/${env.R2_KEY_PREFIX}/`)) return null;
    encodedKey = pathname.slice(1);
  }
  let key: string;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return response("Malformed storage key", 400);
  }
  if (!key) return response(null, 404);
  return { key, s3 };
}

/** Local-only S3/public delivery adapter; signatures and expiry are deliberately
 * ignored. Bytes remain in Wrangler's persistent R2 binding, including restarts.
 * Cloudflare image transforms serve the unchanged original locally. */
export async function handleLocalStorageRequest(
  request: Request,
  env: LocalStorageEnv,
): Promise<Response | null> {
  const route = storageRoute(request, env);
  if (route === null || route instanceof Response) return route;
  const { key, s3 } = route;
  if (request.method === "OPTIONS") return response(null, 204);
  if (s3 && request.method === "PUT") {
    const metadata = new Headers(request.headers);
    if (!metadata.has("Content-Type"))
      metadata.set("Content-Type", "application/octet-stream");
    // Synthetic local uploads can arrive without Content-Length; R2 requires
    // a known-length stream or buffer even when ordinary HTTP accepts them.
    const stored = await env.LOCAL_DEV_STORAGE.put(
      key,
      await request.arrayBuffer(),
      {
        httpMetadata: {
          contentType:
            metadata.get("Content-Type") ?? "application/octet-stream",
          cacheControl: metadata.get("Cache-Control") ?? undefined,
          contentDisposition: metadata.get("Content-Disposition") ?? undefined,
        },
      },
    );
    return response(null, 200, new Headers({ ETag: stored.httpEtag }));
  }
  if (s3 && request.method === "DELETE") {
    await env.LOCAL_DEV_STORAGE.delete(key);
    return response(null, 204);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return response(
      null,
      405,
      new Headers({ Allow: s3 ? methods : "GET, HEAD, OPTIONS" }),
    );
  }
  return readObject(request, env.LOCAL_DEV_STORAGE, key);
}

async function readObject(request: Request, bucket: R2Bucket, key: string) {
  const rangeHeader =
    request.method === "GET" ? request.headers.get("Range") : null;
  let range: { offset: number; length: number } | undefined;
  let totalSize: number | undefined;
  if (rangeHeader) {
    const metadata = await bucket.head(key);
    if (!metadata) return response(null, 404);
    totalSize = metadata.size;
    const parsed = byteRange(rangeHeader, metadata.size);
    if (!parsed) {
      return response(
        null,
        416,
        new Headers({ "Content-Range": `bytes */${metadata.size}` }),
      );
    }
    range = parsed;
  }
  const object = await bucket.head(key);
  if (!object) return response(null, 404);
  const headers = new Headers();
  const metadata = object.httpMetadata;
  if (metadata?.contentType) headers.set("Content-Type", metadata.contentType);
  if (metadata?.cacheControl)
    headers.set("Cache-Control", metadata.cacheControl);
  if (metadata?.contentDisposition)
    headers.set("Content-Disposition", metadata.contentDisposition);
  headers.set(
    "Content-Type",
    headers.get("Content-Type") ?? "application/octet-stream",
  );
  headers.set("ETag", object.httpEtag);
  headers.set("Last-Modified", object.uploaded.toUTCString());
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(range?.length ?? object.size));
  if (range)
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${totalSize}`,
    );
  const body =
    request.method === "HEAD"
      ? null
      : await bucket.get(key, range ? { range } : undefined);
  return response(
    body ? await body.arrayBuffer() : null,
    range ? 206 : 200,
    headers,
  );
}
