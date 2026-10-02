import { handleLocalStorageRequest, type LocalStorageEnv } from "./dev/storage";

export default {
  async fetch(request: Request, env: LocalStorageEnv) {
    const url = new URL(request.url);
    // Existing S3 clients use endpoint/bucket/key; the shared adapter reserves
    // its own prefix so public object delivery remains read-only.
    if (url.pathname.startsWith(`/${env.R2_BUCKET_NAME}/`)) {
      url.pathname = `/__local-storage/s3${url.pathname}`;
      request = new Request(url, request);
    }
    return (
      (await handleLocalStorageRequest(request, env)) ??
      new Response(null, { status: 404 })
    );
  },
};
