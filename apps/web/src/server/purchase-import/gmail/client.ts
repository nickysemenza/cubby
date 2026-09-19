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
    // Keep the status-line error if Gmail returned a non-JSON body.
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
}: GmailApiClientOptions): GmailProvider => {
  if (!accessToken.trim()) throw new Error("Gmail access token is required");

  const request = async <T>(
    path: string,
    params?: URLSearchParams,
  ): Promise<T> => {
    const response = await fetcher(pathFor(baseUrl, path, params), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) throw await parseError(response);
    // SAFETY: Each caller supplies the Gmail endpoint's owned response type;
    // normalization validates all fields before they cross into persistence.
    return (await response.json()) as T;
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
