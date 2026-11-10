import type { InferenceFunding } from "./gateway-request";

/**
 * Why one funding source refused a request (ADR 0027). Only capacity and
 * funding refusals classify; bad keys, invalid prompts, outages and plain rate
 * limits on paid or credit routes stay ordinary failures.
 */
type FundingRefusalKind =
  /** A provider credit balance or spend limit (Claude or OpenAI). */
  | "credit_exhausted"
  /** The ChatGPT plan's usage or rate limit. */
  | "plan_quota"
  /** A request the plan cannot carry, or a plan that is unavailable. */
  | "plan_unsupported"
  /** Cubby's own plan window budget. */
  | "plan_budget"
  /** The AI Gateway account has no Unified Billing balance. */
  | "gateway_balance_empty"
  /** The gateway has no BYOK credential for a paid provider. */
  | "byok_missing";

export interface FundingRefusal {
  funding: InferenceFunding;
  kind: FundingRefusalKind;
  /** Cubby answered it before any provider call; it is not a usage row. */
  local: boolean;
  /** When the provider says the refusal lifts, if it names a time. */
  until: number | null;
}

/**
 * A refusal as it reaches Cubby: an HTTP response (`status` + body), or text
 * with no status: a stream's terminal message, or a failure message that
 * wraps the provider body.
 */
export interface FundingFailure {
  status?: number;
  text: string;
  funding: InferenceFunding;
}

const OPENAI_CREDIT_CODE =
  /"(?:code|type)"\s*:\s*"(?:credit_balance_exhausted|insufficient_quota)"/u;
const OPENAI_CREDIT_PREFIX_CODE =
  /^(?:unknown:\s*)?(?:Error Code )?(?:credit_balance_exhausted|insufficient_quota):/u;
const OPENAI_CREDIT_SENTENCE = /^You have no credits remaining\b/u;
const OPENAI_RECORDED_CREDIT = /^OpenAI credit refused\b/u;
const CLAUDE_CREDIT =
  /credit balance is too low|reached your specified[^\n]*API usage limits|enforced_spend_limit_reached/iu;
const CLAUDE_CREDIT_TERMINAL =
  /credit balance is too low|enforced_spend_limit_reached/iu;
const LOCAL_REFUSAL =
  /"type"\s*:\s*"cubby_(?:credit_refused|plan_budget_reached)"/u;
const GATEWAY_BALANCE_EMPTY =
  /Insufficient unified billing balance|Insufficient balance; add money to your gateway or use BYOK/u;
const BYOK_MISSING = /has no BYOK credential/u;
const PLAN_QUOTA_CODE =
  /"(?:code|type)"\s*:\s*"(?:usage_limit_reached|rate_limit_exceeded|subscription_sharing_usage_limit_exceeded)"|"detail"\s*:\s*"Rate limit exceeded"/u;
const PLAN_UNSUPPORTED_CODE =
  /"(?:code|type)"\s*:\s*"(?:subscription_sharing_unsupported_capability|subscription_unavailable)"/u;
const PLAN_BUDGET_CODE = /"(?:code|type)"\s*:\s*"cubby_plan_budget_reached"/u;
const PLAN_QUOTA_TERMINAL =
  /^(?:Error Code )?(?:usage_limit_reached|rate_limit_exceeded|subscription_sharing_usage_limit_exceeded):/u;
const PLAN_QUOTA_SENTENCE =
  "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.";
// Stored failure text names the plan code anywhere in its wrapped body.
const PLAN_QUOTA_TEXT =
  /usage_limit_reached|rate_limit_exceeded|subscription_sharing_usage_limit_exceeded/u;

function objectMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("message" in value))
    return undefined;
  return typeof value.message === "string" ? value.message : undefined;
}

/** The provider `error.message` of a JSON envelope, if the text is one. */
function providerErrorMessage(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return undefined;
    const direct = "error" in parsed ? objectMessage(parsed.error) : undefined;
    if (direct) return direct;
    if ("message" in parsed && !("error" in parsed))
      return objectMessage(parsed);
    if (!("response" in parsed) || !parsed.response) return undefined;
    return typeof parsed.response === "object" && "error" in parsed.response
      ? objectMessage(parsed.response.error)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * OpenAI's prepaid-balance refusal. The Responses envelope carries
 * `error.code` / `error.type` (`credit_balance_exhausted`, sometimes still
 * `insufficient_quota`); pi-ai prefixes that code on a terminal message and
 * prefixes a codeless one with `unknown:`, or wraps the HTTP body as
 * `OpenAI API error (429): {…}`. With no code, OpenAI's billing sentence is
 * the refusal, read from the provider message when the text is JSON so prompt
 * text echoed elsewhere in a body never matches. Claude's recorded
 * `cubby_credit_refused` shares the type and is not this refusal.
 */
function isOpenAiCredit(text: string): boolean {
  if (OPENAI_CREDIT_CODE.test(text) || OPENAI_CREDIT_PREFIX_CODE.test(text))
    return true;
  const trimmed = text.trim();
  const unwrapped =
    /^(?:unknown:\s*)?(?:OpenAI API error \(\d{3}\):\s*)?([\s\S]*)$/u.exec(
      trimmed,
    )?.[1] ?? trimmed;
  const field = providerErrorMessage(unwrapped);
  if (field === undefined && unwrapped.startsWith("{")) return false;
  const message = field ?? unwrapped;
  return (
    OPENAI_CREDIT_SENTENCE.test(message) || OPENAI_RECORDED_CREDIT.test(message)
  );
}

/** A refusal wrapped after a prefix (settlement, run errors) carries its body. */
function embeddedJson(text: string): string | undefined {
  const embedded = /\{[\s\S]*\}/u.exec(text)?.[0];
  return embedded && embedded !== text ? embedded : undefined;
}

/**
 * When the refusal lifts, if the refusal names it: Anthropic's "You will
 * regain access on 2026-11-01 at 00:00 UTC", or the plan's `resets_at` /
 * `resets_in_seconds`.
 */
function namedUntil(text: string, now: number): number | null {
  const regain =
    /regain access on (\d{4}-\d{2}-\d{2})(?: at (\d{1,2}):(\d{2}))?/u.exec(
      text,
    );
  if (regain) {
    const at = Date.parse(
      `${regain[1]}T${(regain[2] ?? "0").padStart(2, "0")}:${regain[3] ?? "00"}:00Z`,
    );
    return Number.isFinite(at) && at > now ? at : null;
  }
  const absolute = /"resets_at"\s*:\s*(\d{9,})/u.exec(text);
  if (absolute) return Number(absolute[1]) * 1000;
  const relative = /"resets_in_seconds"\s*:\s*(\d+)/u.exec(text);
  return relative ? now + Number(relative[1]) * 1000 : null;
}

function kindOf({
  status,
  text,
  funding,
}: FundingFailure): FundingRefusalKind | null {
  const http = status !== undefined;
  if (funding === "paid") {
    if (GATEWAY_BALANCE_EMPTY.test(text)) return "gateway_balance_empty";
    return BYOK_MISSING.test(text) ? "byok_missing" : null;
  }
  if (http && ![400, 402, 429].includes(status)) return null;
  if (funding === "subscription") {
    if (http && status === 402) return null;
    if (PLAN_BUDGET_CODE.test(text)) return "plan_budget";
    if (PLAN_UNSUPPORTED_CODE.test(text)) return "plan_unsupported";
    if (http) return PLAN_QUOTA_CODE.test(text) ? "plan_quota" : null;
    return PLAN_QUOTA_TERMINAL.test(text) ||
      text === PLAN_QUOTA_SENTENCE ||
      PLAN_QUOTA_TEXT.test(text)
      ? "plan_quota"
      : null;
  }
  if (funding === "openai_credit") {
    const embedded = http ? undefined : embeddedJson(text);
    return isOpenAiCredit(text) || (embedded && isOpenAiCredit(embedded))
      ? "credit_exhausted"
      : null;
  }
  // A recorded OpenAI refusal shares `cubby_credit_refused`; it is never Claude's.
  if (OPENAI_RECORDED_CREDIT.test(providerErrorMessage(text) ?? ""))
    return null;
  if (/cubby_credit_refused/u.test(text)) return "credit_exhausted";
  return (http ? CLAUDE_CREDIT : CLAUDE_CREDIT_TERMINAL).test(text)
    ? "credit_exhausted"
    : null;
}

/** The one classifier for funding refusals; null for every other failure. */
export function classifyFundingRefusal(
  failure: FundingFailure,
  now = Date.now(),
): FundingRefusal | null {
  const kind = kindOf(failure);
  if (!kind) return null;
  return {
    funding: failure.funding,
    kind,
    local: kind === "plan_budget" || LOCAL_REFUSAL.test(failure.text),
    until: namedUntil(failure.text, now),
  };
}

/**
 * The paid rung itself cannot answer — no balance or no credential — whatever
 * wraps the gateway's text. No later attempt answers until someone changes it.
 */
export const paidFundingRefusal = (text: string, now = Date.now()) =>
  classifyFundingRefusal({ text, funding: "paid" }, now);
