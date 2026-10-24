import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { CorrectionAuthorityEvidence } from "./correction-authority-evidence";

it("discloses competing corrected values and their application receipts without model confidence or actions", () => {
  const html = renderToStaticMarkup(
    <CorrectionAuthorityEvidence
      decision={{
        status: "conflict",
        correctionKey: "synthetic-key",
        revision: "synthetic-revision",
        sources: [
          {
            sourceFeedbackId: "00000000-0000-4000-8000-000000000001",
            sourceApplicationFeedbackId: "00000000-0000-4000-8000-000000000002",
            value: null,
          },
          {
            sourceFeedbackId: "00000000-0000-4000-8000-000000000003",
            sourceApplicationFeedbackId: "00000000-0000-4000-8000-000000000004",
            value: "Synthetic category",
          },
        ],
      }}
    />,
  );
  expect(html).toContain("None");
  expect(html).toContain("Synthetic category");
  expect(html).toContain("Application receipt:");
  expect(html).toContain("00000000-0000-4000-8000-000000000004");
  expect(html).not.toContain("Confidence");
  expect(html).not.toContain("0%");
  expect(html).not.toContain("button");
});
