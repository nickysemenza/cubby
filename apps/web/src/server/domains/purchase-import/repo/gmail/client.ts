import { readResponseWithLimit } from "@cubby/shared/external-fetch";
import { retryWithBackoff, sleep as defaultSleep } from "@cubby/shared/retry";
import { z } from "zod";

import {
  GmailApiError,
  type GmailAttachmentPayload,
  type GmailHistoryPage,
  type GmailMessage,
  type GmailMessageListPage,
  type GmailProfile,
  type GmailProvider,
} from "~/server/domains/purchase-import/repo/gmail/types";

const MAX_GMAIL_RESPONSE_BYTES = 36 * 1024 * 1024;
const DEFAULT_BASE_URL = "https://gmail.googleapis.com/gmail/v1";

export type GmailFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type GmailApiClientOptions = {
  accessToken: string;
  baseUrl?: string;
  fetcher?: GmailFetcher;
  sleep?: (ms: number) => Promise<void>;
};

const gmailErrorBody = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        errors: z.array(z.object({ reason: z.string().optional() })).optional(),
      })
      .optional(),
  })
  .loose();

const parseError = async (response: Response): Promise<GmailApiError> => {
  const body = await response.text();
  const status = `${response.status} ${response.statusText}`.trim();
  const message = body ? `${status}\n${body}` : status;
  let reason: string | undefined;
  try {
    if (body) {
      const decoded = gmailErrorBody.safeParse(JSON.parse(body));
      if (decoded.success) {
        reason = decoded.data.error?.errors?.[0]?.reason;
      }
    }
  } catch {
    // SILENT: non-JSON provider diagnostics are retained verbatim above.
  }
  const transient =
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 403 &&
      (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"));
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : Number.NaN;
  const date = header ? Date.parse(header) : Number.NaN;
  const retryAt =
    Number.isFinite(seconds) && seconds >= 0
      ? Date.now() + seconds * 1_000
      : Number.isFinite(date)
        ? date
        : Date.now() + 30_000;
  return new GmailApiError({
    status: response.status,
    message,
    reason,
    ...(transient ? { retryAt: Math.max(retryAt, Date.now() + 1_000) } : {}),
  });
};

const pathFor = (baseUrl: string, path: string, params?: URLSearchParams) => {
  const url = new URL(path, `${baseUrl.replace(/\/+$/u, "")}/`);
  params?.sort();
  for (const [key, value] of params ?? []) {
    url.searchParams.set(key, value);
  }
  return url;
};

export const createGmailApiClient = ({
  accessToken,
  baseUrl = DEFAULT_BASE_URL,
  fetcher = fetch,
  sleep = defaultSleep,
}: GmailApiClientOptions): GmailProvider => {
  if (!accessToken.trim()) throw new Error("Gmail access token is required");

  const request = async <T>(
    path: string,
    params?: URLSearchParams,
  ): Promise<T> => {
    let previous: Response | undefined;
    const response = await retryWithBackoff(
      async () => {
        // A retry releases the preceding body before taking another connection.
        await previous?.body?.cancel();
        previous = await fetcher(pathFor(baseUrl, path, params), {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
          },
        });
        return previous;
      },
      {
        sleep,
        // Throttling and provider deadlines reach the shared cooldown owner
        // before another request; server failures without a deadline retry here.
        delayFor: (outcome, attempt) =>
          outcome.ok &&
          outcome.value.status >= 500 &&
          !outcome.value.headers.has("retry-after") &&
          attempt < 2
            ? 500 * 2 ** attempt
            : null,
      },
    );
    if (response.ok) {
      // Model-message admission is separate from retaining original attachments.
      const bytes = await readResponseWithLimit(
        response,
        MAX_GMAIL_RESPONSE_BYTES,
      );
      // SAFETY: Each caller supplies the owned Gmail response type; normalization validates persistence fields.
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    }
    throw await parseError(response);
  };

  return {
    async getProfile(): Promise<GmailProfile> {
      return await request<GmailProfile>("users/me/profile");
    },

    async listMessages(options): Promise<GmailMessageListPage> {
      const params = new URLSearchParams({
        maxResults: String(options.maxResults ?? 100),
        q: options.query,
      });
      if (options.pageToken) params.set("pageToken", options.pageToken);
      return await request<GmailMessageListPage>("users/me/messages", params);
    },

    async getMessage(messageId: string): Promise<GmailMessage> {
      return await request<GmailMessage>(
        `users/me/messages/${encodeURIComponent(messageId)}`,
        new URLSearchParams({ format: "full" }),
      );
    },

    async listHistory(options): Promise<GmailHistoryPage> {
      const params = new URLSearchParams({
        maxResults: String(options.maxResults ?? 100),
        startHistoryId: options.startHistoryId,
      });
      if (options.pageToken) params.set("pageToken", options.pageToken);
      return await request<GmailHistoryPage>("users/me/history", params);
    },

    async getAttachment(
      messageId: string,
      attachmentId: string,
    ): Promise<GmailAttachmentPayload> {
      return await request<GmailAttachmentPayload>(
        `users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      );
    },
  };
};
