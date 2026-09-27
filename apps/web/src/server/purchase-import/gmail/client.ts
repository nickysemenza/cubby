import { z } from "zod";

import {
  GmailApiError,
  type GmailAttachmentPayload,
  type GmailHistoryPage,
  type GmailMessage,
  type GmailMessageListPage,
  type GmailProfile,
  type GmailProvider,
} from "./types";

const DEFAULT_BASE_URL = "https://gmail.googleapis.com/gmail/v1";
const MAX_ERROR_BODY = 1_000;

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

const retryDelay = (response: Response, attempt: number): number => {
  const header = response.headers.get("Retry-After");
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1_000, 10_000);
  const date = header ? Date.parse(header) : Number.NaN;
  if (Number.isFinite(date))
    return Math.min(Math.max(date - Date.now(), 0), 10_000);
  return 500 * 2 ** attempt;
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
  let message = `${response.status} ${response.statusText}`.trim();
  let reason: string | undefined;
  try {
    const text = (await response.text()).slice(0, MAX_ERROR_BODY);
    if (text) {
      const decoded = gmailErrorBody.safeParse(JSON.parse(text));
      if (decoded.success) {
        message = decoded.data.error?.message ?? message;
        reason = decoded.data.error?.errors?.[0]?.reason;
      }
    }
  } catch {
    // SILENT: a non-JSON error body falls back to the HTTP status line
    // already computed above — `message`/`reason` just keep their defaults.
  }
  return new GmailApiError({ status: response.status, message, reason });
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
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: GmailApiClientOptions): GmailProvider => {
  if (!accessToken.trim()) throw new Error("Gmail access token is required");

  const request = async <T>(
    path: string,
    params?: URLSearchParams,
  ): Promise<T> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetcher(pathFor(baseUrl, path, params), {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
        },
      });
      if (response.ok) {
        // SAFETY: Each caller supplies the Gmail endpoint's owned response type;
        // normalization validates all fields before they cross into persistence.
        return (await response.json()) as T;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      throw await parseError(response);
    }
    throw new Error("Gmail retry loop exhausted");
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
