import { describe, expect, it } from "vitest";

import { generatePresignedUploadUrl } from "./s3";

describe("generatePresignedUploadUrl", () => {
  it("binds the required Content-Type into the aws4fetch query signature", async () => {
    const [jpegUrl, pngUrl] = await Promise.all([
      generatePresignedUploadUrl({
        key: "test/item.jpg",
        contentType: "image/jpeg",
      }),
      generatePresignedUploadUrl({
        key: "test/item.jpg",
        contentType: "image/png",
      }),
    ]);
    const jpeg = new URL(jpegUrl);
    const png = new URL(pngUrl);

    expect(jpeg.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain(
      "content-type",
    );
    expect(jpeg.searchParams.get("X-Amz-Signature")).not.toBe(
      png.searchParams.get("X-Amz-Signature"),
    );
  });
});
