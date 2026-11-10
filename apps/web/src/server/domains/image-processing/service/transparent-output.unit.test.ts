import { expect, it } from "vitest";

import { transparentOutputFailure } from "./image-processing.service";

const claimed = {
  contentType: "image/png" as const,
  sha256: "a".repeat(64),
  width: 12,
  height: 8,
};
const stored = {
  detectedContentType: "image/png",
  sha256: claimed.sha256,
  width: 12,
  height: 8,
};

it("accepts a stored PNG that matches the claimed bytes", () => {
  expect(
    transparentOutputFailure("image/png", stored, claimed, true),
  ).toBeNull();
});

it("names the failed check and keeps the claim beside the stored bytes", () => {
  const mismatch = transparentOutputFailure(
    "text/plain",
    { ...stored, sha256: "b".repeat(64), width: 3, height: 4 },
    claimed,
    false,
  );
  expect(mismatch?.message).toContain(
    "content-type claimed image/png, stored text/plain",
  );
  expect(mismatch?.message).toContain(
    `sha256 claimed ${claimed.sha256}, stored ${"b".repeat(64)}`,
  );
  expect(mismatch?.message).toContain("width claimed 12, stored 3");
  expect(mismatch?.message).toContain("height claimed 8, stored 4");
  expect(mismatch?.message).toContain(
    "transparency claimed meaningful, stored none",
  );
  expect(mismatch?.message).not.toContain("png-signature");
  expect(mismatch?.outputCheck.claimed).toEqual(claimed);
  expect(mismatch?.outputCheck.stored).toMatchObject({
    contentType: "text/plain",
    sha256: "b".repeat(64),
    width: 3,
    height: 4,
    transparency: false,
  });
});
