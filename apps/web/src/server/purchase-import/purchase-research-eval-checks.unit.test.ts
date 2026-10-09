import { createHash } from "node:crypto";

import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared/constants";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, it, vi } from "vitest";

import {
  canonicalFailures,
  researchEvalCases,
  retainedSourceFailures,
  waitForResearchEvalSettlement,
} from "./purchase-research-eval.fixtures";

it("stops a paused offline evaluation at its first hard inference refusal", async () => {
  const begin = Date.now();
  expect(
    await waitForResearchEvalSettlement({
      begin,
      timeoutMs: 500,
      readState: async () => "running",
      readBudgets: async () => [{ refusedRequests: 1 }],
    }),
  ).toBe("budget_refused");
  expect(Date.now() - begin).toBeLessThan(250);
});

it("reports missing proof without mislabeling an unchanged sentinel as an unsupported mutation", () => {
  const baseline = fromPartial<
    NonNullable<Parameters<typeof canonicalFailures>[1]>
  >({
    manufacturer: UNSPECIFIED_MANUFACTURER,
    model: "",
    categoryId: null,
  });
  expect(
    canonicalFailures(researchEvalCases[0]!, baseline, [], [], baseline),
  ).toEqual([]);
  expect(
    canonicalFailures(
      researchEvalCases[0]!,
      { ...baseline, model: "WRONG-99" },
      [],
      [],
      baseline,
    ),
  ).toContain("Unsupported canonical identity/category/image mutation");
});

it("accepts the admitted owned mail and public source while rejecting replaced or unrecognized retained bytes", async () => {
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const mail = fromPartial<Parameters<typeof retainedSourceFailures>[3]>({
    id: "11111111-1111-4111-8111-111111111111",
    rawChecksum: hash("original receipt"),
    sender: "orders@maker.example.test",
    subject: "Synthetic purchase",
    receivedAt: new Date("2026-09-01T12:00:00Z"),
    content: { snippet: null, bodyHtml: null, bodyText: "original receipt" },
  });
  const mailBytes = JSON.stringify({
    sender: mail.sender,
    subject: mail.subject,
    receivedAt: mail.receivedAt!.toISOString(),
    content: mail.content,
    attachments: [],
  });
  const page = researchEvalCases[0]!.pages[0];
  const mailProof = fromPartial<
    Parameters<typeof retainedSourceFailures>[0][number]
  >({
    kind: "mail_message",
    objectKey: "mail",
    checksum: hash(mailBytes),
    sourceMetadata: {
      orderMailId: mail.id,
      checksum: mail.rawChecksum,
      contextOnly: true,
    },
  });
  const webProof = fromPartial<
    Parameters<typeof retainedSourceFailures>[0][number]
  >({
    kind: "web_page",
    objectKey: "page",
    checksum: hash(page.html),
    sourceMetadata: { sourceURL: page.url, servedURL: page.url },
  });
  const objects = new Map([
    ["mail", mailBytes],
    ["page", page.html],
  ]);
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(objects.get(url.split("/").at(-1)!) ?? "missing"),
  );
  try {
    expect(
      await retainedSourceFailures(
        [mailProof, webProof],
        researchEvalCases[0]!,
        "https://storage.test",
        mail,
      ),
    ).toEqual([]);
    objects.set("page", "changed stored page");
    expect(
      await retainedSourceFailures(
        [webProof],
        researchEvalCases[0]!,
        "https://storage.test",
        mail,
      ),
    ).toContain("Retained source bytes were unavailable or changed");
    objects.set("page", "unrecognized source");
    expect(
      await retainedSourceFailures(
        [{ ...webProof, checksum: hash("unrecognized source") }],
        researchEvalCases[0]!,
        "https://storage.test",
        mail,
      ),
    ).toContain("Evidence did not retain exact fixed source bytes");
    expect(
      await retainedSourceFailures(
        [
          {
            ...mailProof,
            sourceMetadata: {
              checksum: mail.rawChecksum,
              contextOnly: true,
              orderMailId: "22222222-2222-4222-8222-222222222222",
            },
          },
        ],
        researchEvalCases[0]!,
        "https://storage.test",
        mail,
      ),
    ).toContain("Evidence did not retain exact fixed source bytes");
  } finally {
    vi.unstubAllGlobals();
  }
});
