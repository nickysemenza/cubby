/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated Worker postMessage takes transfer options, not a Window target origin. */
import { cookbookBundleMetadataSchema } from "@cubby/schemas/import-recipe";
import { z } from "zod";

import {
  bundleResponseSchema,
  type BundleRequest,
} from "./bundle-worker-protocol";

type BundleValue = z.output<typeof cookbookBundleMetadataSchema> | Uint8Array;

export class CookbookBundleWorker {
  private readonly worker = new Worker(
    new URL("./bundle.worker.ts", import.meta.url),
    { type: "module" },
  );
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: BundleValue) => void; reject: (error: Error) => void }
  >();
  constructor() {
    this.worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const result = bundleResponseSchema.safeParse(event.data);
      if (!result.success) {
        this.close(new Error("Invalid cookbook Worker response"));
        return;
      }
      const response = result.data;
      const pending = this.pending.get(response.id);
      this.pending.delete(response.id);
      if ("error" in response) pending?.reject(new Error(response.error));
      else
        pending?.resolve(
          "metadata" in response ? response.metadata : response.bytes,
        );
    });
    this.worker.addEventListener("error", (error) =>
      this.close(new Error(error.message)),
    );
  }
  private request(
    request:
      | Omit<Extract<BundleRequest, { op: "open" }>, "id">
      | Omit<Extract<BundleRequest, { op: "image" }>, "id">,
  ) {
    const id = ++this.sequence;
    return new Promise<BundleValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id });
    });
  }
  async open(file: File) {
    return cookbookBundleMetadataSchema.parse(
      await this.request({ op: "open", file }),
    );
  }
  async readImage(path: string) {
    return z
      .instanceof(Uint8Array)
      .parse(await this.request({ op: "image", path }));
  }
  close(
    error = new Error(
      "Bundle import cancelled; choose the .cookbook file again to continue",
    ),
  ) {
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
