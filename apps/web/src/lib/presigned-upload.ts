/**
 * Thrown by {@link putPresignedObject} when the presigned PUT itself
 * succeeds in reaching the object store but the store responds non-ok.
 * `status` is the HTTP status; `detail` is the response body text (or a
 * placeholder if the body could not be read).
 */
export class PresignedUploadError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`Storage error (${status}): ${detail}`);
    this.name = "PresignedUploadError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * PUT `body` to a presigned object-store URL (R2) with the given
 * `contentType` header.
 *
 * `contentType` is always the caller's validated content type, never the raw
 * `File#type` the browser reports — a File's `type` can be empty, exotic
 * (notably from iOS), or otherwise not match what the server validated and
 * expects the object to be stored as. Every caller must pass the value it
 * already validated (e.g. against an allowed-content-type schema), not the
 * body's own `.type`.
 */
export async function putPresignedObject(
  uploadUrl: string,
  body: Blob | ArrayBuffer | Uint8Array,
  contentType: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  // A `Uint8Array<ArrayBufferLike>` (its buffer may be a `SharedArrayBuffer`)
  // isn't a valid `BodyInit` on its own; `.slice()` produces a plain,
  // fetch-acceptable `Uint8Array<ArrayBuffer>` copy.
  const fetchBody = body instanceof Uint8Array ? body.slice() : body;
  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: fetchBody,
    headers: { "Content-Type": contentType },
    signal: opts?.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "Unknown error");
    throw new PresignedUploadError(response.status, detail);
  }
}
