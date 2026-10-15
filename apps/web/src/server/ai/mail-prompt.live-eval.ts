import { readFileSync } from "node:fs";

import { runEntityId } from "@cubby/schemas/identifiers";
import { providerFor } from "@cubby/shared/ai/models";
import {
  createAiModelPricing,
  estimateAiUsageCost,
  type AiTokenUsage,
} from "@cubby/shared/ai/pricing";
import {
  emptyEvalUsage,
  evalCostUsd,
  meteredStructuredPorts,
} from "tooling/ai/eval-support";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { localSecret } from "../../../tooling/local-secret";
import { INLINE_EMAIL_PNG_BASE64 } from "../purchase-import/gmail/email-html.fixtures";

// The compactor's developer timing warning includes source snippets.
// Evaluation output keeps timings but never prints the original arguments.
const warn = console.warn.bind(console);
vi.spyOn(console, "warn").mockImplementation((message, ...args: unknown[]) => {
  if (typeof message === "string" && message.startsWith("[wasm]"))
    warn(message);
  else warn(message, ...args);
});

// Billed and sequential. CI uses synthetic production-prompt cases only.
const apiKey = localSecret(["AI_GATEWAY_API_KEY"]);
if (!apiKey)
  throw new Error("AI_GATEWAY_API_KEY is required for the live eval");
process.env.AI_GATEWAY_API_KEY = apiKey;
const { scrubErrorMessage } = await import("~/lib/error-diagnostics");
const { runDecisionChoice } = await import("./decision-model");
const { MAILBOX_TRIAGE_FEATURE, MAILBOX_RELEVANCE_FEATURE } =
  await import("./features");
const { normalizeMessage } = await import("../purchase-import/gmail/normalize");
const { routeGmailMessage } = await import("../purchase-import/gmail/triage");
const { mailTriagePrompt, mailTriageChoices } = await import("./prompts/mail");

// An optional full rules draft is compared without changing deployed routing.
const candidateRules = process.env.MAIL_PROMPT_CANDIDATE_RULES?.trim();

const carrierDigestCases = [
  {
    label: "related",
    body: "Your daily inbound parcel digest: a package from Cedar Hardware is arriving tomorrow. Tracking number SYNTRACK123456. A package from Harbor Books is in transit. Tracking number SYNTRACK789012.",
    html: "",
  },
  {
    label: "unrelated",
    body: "Your daily postal digest contains scanned letters and local advertising circulars. Save on parcel shipping this month. No packages are arriving today.",
    html: "",
  },
  {
    label: "uncertain",
    body: "Packages arriving soon. Open the attached digest to see who sent them and the tracking details. The digest could not be read.",
    html: "",
  },
];

const syntheticCases = [
  {
    label: "unrelated",
    body: "We have something else you may like. Explore our personalized product recommendations. Daily deals: up to 45% off select tools. Free delivery. Shop now.",
    html: '<img src="https://shop.example.test/banner.png?campaign=POSTPURCHASE&placement=recommendations" alt="Daily deals and personalized recommendations">',
  },
  {
    label: "related",
    body: "Because you recently purchased the kettle, we recommend these replacement filters. Explore our latest offers.",
    html: "",
  },
  ...carrierDigestCases,
  {
    label: "unrelated",
    subject: "Weekend dispatch: a shopping trip",
    body: "Read this weekly column online. Last Sunday, we skipped our usual walk and drove to a hardware store. We bought a lamp, paid $45 at checkout, and carried it home. The cashier handed us a receipt. I remembered shopping trips with my parents and how they decorated our house. Next week I will share another story from our travels. Subscribe for more essays. Unsubscribe from this newsletter.",
    html: "",
  },
  {
    label: "uncertain",
    body:
      "Explore our seasonal offers. ".repeat(2500) +
      "Your annual subscription renewed successfully." +
      "Shop the latest collection. ".repeat(2500),
    html: "",
  },
  {
    label: "unrelated",
    body: "Back in stock: cedar fragrance. Free gift with orders $65+. Your orders and communications are safe. We use DKIM and SPF for reliable email delivery. In the event of an order delay we may contact customers. Shop now.",
    html: Array.from(
      { length: 8 },
      (_, i) =>
        `<img src="https://cdn.example.test/${i}.png" alt="Gift with orders $65+ and shipping benefits">`,
    ).join(""),
  },
  {
    label: "unrelated",
    body: "Introducing the new fitness band, from $179.99. Pre-order now. Free delivery available. Explore our collection.",
    html: Array.from(
      { length: 8 },
      (_, i) =>
        `<img src="https://cdn.example.test/${i}.png" alt="New products from $179.99">`,
    ).join(""),
  },
  {
    label: "unrelated",
    body: "You left towels in your cart. Complete checkout to place your order. Total if purchased: $42.00.",
    html: "",
  },
  {
    label: "related",
    body: "Your flight booking is confirmed. Reservation reference SYN-123. Departing next Tuesday. Explore discounted hotel offers.",
    html: "",
  },
  {
    label: "related",
    body: "Seller payout completed. We sent $85.00 to your bank account for your marketplace sales.",
    html: "",
  },
  {
    label: "related",
    body: "How was the kettle you purchased last week? Please review your purchase.",
    html: "",
  },
  {
    label: "related",
    body: "Order SYN-456 confirmed. Paid $42.00. Two cotton towels. Track your shipment.",
    html: Array.from(
      { length: 8 },
      (_, i) =>
        `<img src="https://cdn.example.test/${i}.png" alt="New products from $179.99">`,
    ).join(""),
  },
  {
    label: "uncertain",
    body: "Please see the attached receipt. Its contents could not be read.",
    html: '<img src="https://cdn.example.test/receipt.png" alt="Receipt">',
  },
  {
    label: "uncertain",
    body:
      "Weekly community news. ".repeat(2500) +
      "Receipt order SYN-789 paid $42.00." +
      "More community news. ".repeat(2500),
    html: "",
  },
  {
    label: "unrelated",
    body: "Community newsletter with gardening tips and upcoming neighborhood events.",
    html: '<p>Community newsletter with gardening tips and upcoming neighborhood events.</p><a href="https://example.test/subscription" style="display:none">Manage preferences</a>',
  },
  {
    label: "related",
    body: "",
    html: '<div aria-hidden="true">Your order is confirmed. Order #SYN-12345: synthetic kettle, total $42 paid. Delivery is scheduled for Friday.</div>',
  },
  {
    label: "unrelated",
    body: "",
    html: '<div aria-hidden="true">Community newsletter with gardening tips and upcoming neighborhood events. Explore seasonal planting ideas and visit our public gardens this weekend.</div>',
  },
  {
    label: "unrelated",
    body: "Community newsletter with gardening tips and upcoming events.",
    html: '<p>Community newsletter with gardening tips and upcoming events.</p><div style="display:none"><img width="1" height="1" src="https://example.test/open.gif" alt="Free shipping on orders over $50"></div>',
  },
  {
    label: "related",
    body: "Community updates.",
    html: '<p>Community updates.</p><div style="display:none"><img width="1" height="1" src="https://example.test/open.gif" alt="Your purchase is confirmed. Order #SYN-7788 paid $24"></div>',
  },
] as const;

const inputSchema = z
  .array(
    z
      .object({
        label: z.enum([...mailTriageChoices, "ungraded"]),
        body: z.string(),
        html: z.string().optional(),
        subject: z.string().optional(),
        images: z
          .array(
            z.object({
              mimeType: z.enum([
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
              ]),
              dataBase64: z.string(),
            }),
          )
          .max(6)
          .optional(),
      })
      .refine(
        (entry) => Boolean(entry.body.trim() || entry.html?.trim()),
        "Missing original body",
      ),
  )
  .min(1);
const inputUrl = process.env.MAIL_PROMPT_INPUT_URL;
const privateInput = Boolean(inputUrl);
if (process.env.CI && privateInput)
  throw new Error("CI live Email cases must be synthetic");
let parsedInput = inputSchema.safeParse(syntheticCases);
if (inputUrl) {
  try {
    const response = await fetch(inputUrl);
    if (!response.ok) throw new Error("Private input transport failed");
    parsedInput = inputSchema.safeParse(await response.json());
  } catch {
    throw new Error("Could not read private Email evaluation input");
  }
}
if (!parsedInput.success)
  throw new Error(
    privateInput
      ? "Invalid private Email evaluation input"
      : parsedInput.error.message,
  );
const cases = parsedInput.data;
const evalStage = z
  .enum(["decision", "relevance", "both"])
  .parse(process.env.MAIL_PROMPT_EVAL_STAGE ?? "decision");

async function evaluateDecisions() {
  const pricing = await createAiModelPricing({
    onError: (error) => console.error(scrubErrorMessage(error.message)),
  }).current();
  for (const model of ["typesafe/jev", "@cf/cloudflare/clef"] as const) {
    for (const variant of process.env.MAIL_PROMPT_BASELINE_ONLY === "1" ||
    !candidateRules
      ? (["production"] as const)
      : (["production", "candidate"] as const)) {
      const usageCalls: AiTokenUsage[] = [];
      const counts = {
        inputTokens: 0,
        outputTokens: 0,
        calls: 0,
        gradedCases: cases.filter((entry) => entry.label !== "ungraded").length,
        correct: 0,
        falseNegatives: 0,
        falsePositives: 0,
        uncertain: 0,
        unsafeNegatives: 0,
        unavailable: 0,
        lowConfidenceNegatives: 0,
        rawAbstentions: 0,
        errors: 0,
      };
      for (const [caseIndex, entry] of cases.entries()) {
        let subject = "";
        const part = (body: string, mimeType: string) => ({
          mimeType,
          body: {
            data: Buffer.from(body).toString("base64url"),
            size: Buffer.byteLength(body),
          },
        });
        const parts = [
          part(entry.body, "text/plain"),
          ...(entry.html ? [part(entry.html, "text/html")] : []),
          ...("images" in entry && entry.images
            ? entry.images.map((image, index) => ({
                partId: `synthetic-image-${index}`,
                filename: `synthetic-image-${index}`,
                mimeType: image.mimeType,
                body: {
                  data: Buffer.from(image.dataBase64, "base64").toString(
                    "base64url",
                  ),
                  size: Buffer.from(image.dataBase64, "base64").length,
                },
              }))
            : []),
        ];
        const raw = {
          id: "synthetic-evaluation",
          payload: {
            mimeType: "multipart/alternative",
            headers: [
              { name: "Subject", value: entry.subject ?? "Synthetic Email" },
            ],
            parts,
          },
        };
        const buildPrompt = (content: string) => {
          const prompt = mailTriagePrompt(content);
          return {
            ...prompt,
            rules:
              variant === "production"
                ? prompt.rules
                : (candidateRules ?? prompt.rules),
          };
        };
        const routed = await routeGmailMessage(
          raw,
          normalizeMessage("synthetic-mailbox", raw),
          async (input) => {
            subject = input;
            return "uncertain";
          },
          buildPrompt,
        );
        if (routed.view === null) {
          counts.unavailable++;
          continue;
        }
        const prompt = buildPrompt(subject);
        counts.calls++;
        try {
          const result = await runDecisionChoice({
            ...prompt,
            feature: { ...MAILBOX_TRIAGE_FEATURE, cache: false },
            decisionModel: model,
            onTokenUsage: (usage) => {
              usageCalls.push(usage);
              counts.inputTokens += usage.inputTokens ?? 0;
              counts.outputTokens += usage.outputTokens ?? 0;
            },
            usage: {
              runId: runEntityId.parse(crypto.randomUUID()),
              operation: "mail-prompt-eval",
            },
          });
          const selected =
            result.selectedIndex === null
              ? "uncertain"
              : (mailTriageChoices[result.selectedIndex] ?? "uncertain");
          counts.rawAbstentions += Number(selected === "uncertain");
          counts.lowConfidenceNegatives += Number(
            selected === "unrelated" && result.confidence !== "high",
          );
          const classification =
            selected === "unrelated" && result.confidence !== "high"
              ? "uncertain"
              : selected;
          if (!privateInput && classification !== entry.label)
            console.log(
              JSON.stringify({
                caseIndex,
                expected: entry.label,
                classification,
                confidence: result.confidence,
                probability: result.probability,
              }),
            );
          counts.correct += Number(classification === entry.label);
          counts.falseNegatives += Number(
            entry.label === "related" && classification === "unrelated",
          );
          counts.falsePositives += Number(
            entry.label === "unrelated" && classification === "related",
          );
          counts.uncertain += Number(classification === "uncertain");
          counts.unsafeNegatives += Number(
            entry.label === "uncertain" && classification === "unrelated",
          );
        } catch (error) {
          counts.errors++;
          if (!privateInput)
            console.error(
              scrubErrorMessage(
                error instanceof Error ? error.message : String(error),
              ),
            );
        }
      }
      const costs = usageCalls.map((usage) =>
        estimateAiUsageCost(pricing, providerFor(model), model, usage),
      );
      const estimatedUsd =
        usageCalls.length !== counts.calls ||
        costs.some((cost) => cost === null)
          ? null
          : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
      console.log(JSON.stringify({ model, variant, ...counts, estimatedUsd }));
      expect(counts.errors).toBe(0);
      const strict = process.env.MAIL_PROMPT_BASELINE_ONLY === "1";
      expect(counts.unavailable).toBe(strict ? 0 : counts.unavailable);
      expect(counts.correct).toBe(strict ? counts.gradedCases : counts.correct);
      expect(counts.falseNegatives).toBe(0);
      expect(counts.unsafeNegatives).toBe(0);
    }
  }
}

type RawRelevanceResult = {
  classification:
    | z.infer<typeof MAILBOX_RELEVANCE_FEATURE.schema>["classification"]
    | null;
};

async function evaluateRelevance() {
  const { runStructuredFeature } = await import("./run-feature");
  const { piCallTarget } = await import("./adapters");
  const { interpretMailRelevance } =
    await import("../purchase-import/gmail/relevance");
  const fallbackCases = privateInput
    ? cases
    : [
        ...["png", "webp", "gif"].map((format) => ({
          label: "related" as const,
          body: "See the supplied image for the message content.",
          html: "",
          images: [
            {
              mimeType: `image/${format}`,
              dataBase64: readFileSync(
                new URL(
                  `../purchase-import/gmail/fixtures/synthetic-seller-payout.${format}`,
                  import.meta.url,
                ),
              ).toString("base64"),
            },
          ],
        })),
        {
          label: "related",
          body: "See the supplied image for the message content.",
          html: "",
          images: [
            {
              mimeType: "image/png",
              dataBase64: readFileSync(
                new URL(
                  "../purchase-import/gmail/fixtures/synthetic-tall-receipt.png",
                  import.meta.url,
                ),
              ).toString("base64"),
            },
          ],
        },
        {
          label: "related" as const,
          body: "See the supplied image for the message content.",
          html: "",
          images: [
            {
              mimeType: "image/jpeg",
              dataBase64: readFileSync(
                new URL(
                  "../purchase-import/gmail/fixtures/synthetic-photographic-receipt.jpg",
                  import.meta.url,
                ),
              ).toString("base64"),
            },
          ],
        },
        ...cases.slice(0, 2),
        ...carrierDigestCases,
        ...cases.slice(-2),
        {
          label: "related",
          body: "How was the kettle you purchased last week? Please review your purchase.",
          html: "",
        },
        {
          label: "related",
          body: "Order SYN-456 confirmed. Paid $42.00. Two cotton towels. You might also like these bath mats.",
          html: "",
        },
        {
          label: "unrelated",
          body: "Community newsletter with gardening tips and upcoming neighborhood events.",
          html: '<p>Community newsletter with gardening tips and upcoming neighborhood events.</p><img src="cid:synthetic-logo%40example.test">',
          inlineImage: true,
        },
      ];
  const usage = emptyEvalUsage();
  const ports = meteredStructuredPorts(usage, piCallTarget);
  const ctx = {
    runId: runEntityId.parse(crypto.randomUUID()),
    operation: "mail-relevance-prompt-eval",
  };
  const confusion: Record<string, number> = {};
  const counts = {
    cases: fallbackCases.length,
    gradedCases: fallbackCases.filter((entry) => entry.label !== "ungraded")
      .length,
    noInference: 0,
    rawCorrect: 0,
    guardedCorrect: 0,
    rawUnrelated: 0,
    rawRelated: 0,
    rawUncertain: 0,
    guardedUncertain: 0,
    negativeVetoes: 0,
    errors: 0,
  };
  for (const [caseIndex, entry] of fallbackCases.entries()) {
    const part = (body: string, mimeType: string) => ({
      mimeType,
      body: {
        data: Buffer.from(body).toString("base64url"),
        size: Buffer.byteLength(body),
      },
    });
    const raw = {
      id: "synthetic-relevance-evaluation",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          {
            name: "Subject",
            value:
              "subject" in entry
                ? (entry.subject ?? "Synthetic Email")
                : "Synthetic Email",
          },
        ],
        parts: [
          part(entry.body, "text/plain"),
          ...(entry.html ? [part(entry.html, "text/html")] : []),
          ...("images" in entry && entry.images
            ? entry.images.map((image, index) => ({
                partId: `synthetic-image-${index}`,
                filename: `synthetic-image-${index}`,
                mimeType: image.mimeType,
                body: {
                  data: Buffer.from(image.dataBase64, "base64").toString(
                    "base64url",
                  ),
                  size: Buffer.from(image.dataBase64, "base64").length,
                },
              }))
            : []),
          ...("inlineImage" in entry && entry.inlineImage
            ? [
                {
                  mimeType: "image/png",
                  headers: [
                    {
                      name: "Content-ID",
                      value: "<synthetic-logo@example.test>",
                    },
                  ],
                  body: {
                    data: Buffer.from(
                      INLINE_EMAIL_PNG_BASE64,
                      "base64",
                    ).toString("base64url"),
                    size: Buffer.from(INLINE_EMAIL_PNG_BASE64, "base64").length,
                  },
                },
              ]
            : []),
        ],
      },
    };
    const rawResult: RawRelevanceResult = { classification: null };
    try {
      const guarded = await interpretMailRelevance(
        {
          getProfile: async () => ({ historyId: "100" }),
          listMessages: async () => ({}),
          listHistory: async () => ({}),
          getMessage: async () => {
            throw new Error(
              "Synthetic fallback cases have no external Gmail reads",
            );
          },
          getAttachment: async () => {
            throw new Error(
              "Fallback body-only evaluation cannot fetch attachments",
            );
          },
        },
        normalizeMessage("synthetic-mailbox", raw),
        async (request) => {
          const decision = await runStructuredFeature(
            MAILBOX_RELEVANCE_FEATURE,
            request,
            ctx,
            ports,
          );
          rawResult.classification = decision.classification;
          return decision;
        },
      );
      const rawClassification = rawResult.classification;
      if (
        !privateInput &&
        (rawClassification !== entry.label ||
          guarded.classification !== entry.label)
      )
        console.log(
          JSON.stringify({
            caseIndex,
            expected: entry.label,
            rawClassification,
            classification: guarded.classification,
          }),
        );
      if (entry.label !== "ungraded") {
        const cell = `${entry.label}->${guarded.classification}`;
        confusion[cell] = (confusion[cell] ?? 0) + 1;
      }
      counts.noInference += Number(rawClassification === null);
      counts.rawCorrect += Number(
        rawClassification !== null && rawClassification === entry.label,
      );
      counts.guardedCorrect += Number(guarded.classification === entry.label);
      counts.rawUnrelated += Number(rawClassification === "unrelated");
      counts.rawRelated += Number(rawClassification === "related");
      counts.rawUncertain += Number(rawClassification === "uncertain");
      counts.guardedUncertain += Number(guarded.classification === "uncertain");
      counts.negativeVetoes += Number(
        rawClassification === "unrelated" &&
          guarded.classification === "uncertain",
      );
    } catch (error) {
      counts.errors++;
      if (!privateInput)
        console.error(
          scrubErrorMessage(
            error instanceof Error ? error.message : String(error),
          ),
        );
    }
  }
  console.log(
    JSON.stringify({
      model: MAILBOX_RELEVANCE_FEATURE.model,
      ...counts,
      confusion,
      usage,
      estimatedUsd: await evalCostUsd(MAILBOX_RELEVANCE_FEATURE.model, usage),
    }),
  );
  expect(counts.errors).toBe(0);
  const expected = privateInput ? counts.rawCorrect : fallbackCases.length;
  expect(counts.rawCorrect).toBe(expected);
  expect(counts.noInference).toBe(privateInput ? counts.noInference : 0);
  expect(counts.guardedCorrect).toBe(
    privateInput ? counts.guardedCorrect : fallbackCases.length,
  );
}

describe("live Email prompt evaluation", () => {
  it("evaluates the selected stages through production model runners", async () => {
    expect.hasAssertions();
    if (evalStage !== "relevance") await evaluateDecisions();
    if (evalStage !== "decision") await evaluateRelevance();
  }, 1_200_000);
});
