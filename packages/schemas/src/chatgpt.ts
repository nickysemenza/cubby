import { z } from "zod";

export const chatGptModel = z.object({
  slug: z.string().min(1),
  display_name: z.string(),
  visibility: z.string().optional(),
});
export const chatGptModels = z.object({ models: z.array(chatGptModel) });
export const chatGptStatus = z.object({
  connected: z.boolean(),
  needsReauthorization: z.boolean().default(false),
  email: z.string().nullable(),
});
export const chatGptAuthorization = z.object({
  code: z.string().min(1).max(8192),
  clientId: z.string().startsWith("oaiapp_"),
  verifier: z.string().min(43).max(128),
  nonce: z.string().min(16).max(256),
  redirectUri: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.pathname === "/auth/callback" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  }, "OpenAI requires an HTTP 127.0.0.1 /auth/callback"),
});
export type ChatGptModel = z.infer<typeof chatGptModel>;
export type ChatGptStatus = z.infer<typeof chatGptStatus>;
export type ChatGptAuthorization = z.infer<typeof chatGptAuthorization>;

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

export const chatGptAuthorizationHost = z.object({
  hostId: z.string(),
  clientId: z.string().nullable(),
});
