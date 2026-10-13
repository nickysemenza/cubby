import { runEntityId } from "@cubby/schemas/identifiers";
import { providerFor } from "@cubby/shared/ai/models";
import {
  createAiModelPricing,
  estimateAiUsageCost,
  type AiTokenUsage,
} from "@cubby/shared/ai/pricing";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { localSecret } from "../../../tooling/local-secret";

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
const { MAILBOX_TRIAGE_FEATURE } = await import("./features");
const { normalizeMessage } = await import("../purchase-import/gmail/normalize");
const { routeGmailMessage } = await import("../purchase-import/gmail/triage");
const { mailTriagePrompt, mailTriageChoices } = await import("./prompts/mail");

// An optional full rules draft is compared without changing deployed routing.
const candidateRules = process.env.MAIL_PROMPT_CANDIDATE_RULES?.trim();

const syntheticCases = [
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
] as const;

const inputSchema = z
  .array(
    z
      .object({
        label: z.enum(mailTriageChoices),
        body: z.string(),
        html: z.string().optional(),
        subject: z.string().optional(),
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

describe("synthetic Email prompt comparison", () => {
  it("compares candidate and production prompts through both decision models", async () => {
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
        console.log(
          JSON.stringify({ model, variant, ...counts, estimatedUsd }),
        );
        expect(counts.errors).toBe(0);
        const strict = process.env.MAIL_PROMPT_BASELINE_ONLY === "1";
        expect(counts.unavailable).toBe(strict ? 0 : counts.unavailable);
        expect(counts.correct).toBe(strict ? cases.length : counts.correct);
        expect(counts.falseNegatives).toBe(0);
        expect(counts.unsafeNegatives).toBe(0);
      }
    }
  }, 1_200_000);
});
