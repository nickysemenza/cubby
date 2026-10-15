import { expect, it } from "vitest";

import { safeImageProcessingError } from "./safe-error";
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
