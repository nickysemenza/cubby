/* oxlint-disable unicorn/require-post-message-target-origin -- This module runs in a DedicatedWorker; postMessage transfers bytes and has no Window target origin. */
import { openCookbookBundle } from "./bundle";
import { bundleRequestSchema } from "./bundle-worker-protocol";

let bundle: Awaited<ReturnType<typeof openCookbookBundle>> | undefined;
self.addEventListener("message", async (event: MessageEvent<unknown>) => {
  const parsed = bundleRequestSchema.safeParse(event.data);
  if (!parsed.success) return;
  const request = parsed.data;
  try {
    if (request.op === "open") {
      bundle = await openCookbookBundle(request.file);
      self.postMessage({ id: request.id, metadata: bundle.metadata });
    } else {
      if (!bundle) throw new Error("Choose the original .cookbook file again");
      const bytes = await bundle.readImage(request.path);
      self.postMessage({ id: request.id, bytes }, { transfer: [bytes.buffer] });
    }
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
