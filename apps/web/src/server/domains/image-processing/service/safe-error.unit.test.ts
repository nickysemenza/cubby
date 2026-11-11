import { expect, it } from "vitest";

import { cloudFailureRetryable, safeImageProcessingError } from "./safe-error";
it("does not persist signed URLs, bearer tokens, or credential values in provider errors", () => {
  const message = safeImageProcessingError(
    new Error(
      "Fetch https://storage.example/object?X-Amz-Signature=private failed Bearer private-token api_key=private-key",
    ),
  );
  expect(message).not.toContain("private");
  expect(message).toContain("failed");
  expect(safeImageProcessingError(new Error("x".repeat(2000)))).toHaveLength(
    1000,
  );
});

it("settles a provider refusal of the request and backs off transient failures", () => {
  const refused = (status: number) =>
    new Error("AI Gateway request failed", {
      cause: Object.assign(new Error(`HTTP ${status}`), { status }),
    });
  expect(cloudFailureRetryable(refused(404))).toBe(false);
  expect(cloudFailureRetryable(refused(400))).toBe(false);
  expect(cloudFailureRetryable(refused(429))).toBe(true);
  expect(cloudFailureRetryable(refused(503))).toBe(true);
  expect(cloudFailureRetryable(new Error("socket hang up"))).toBe(true);
});
