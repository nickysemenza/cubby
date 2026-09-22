import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    R2_ENDPOINT: z.string().url(),
    R2_BUCKET_NAME: z.string().min(1),
    R2_PUBLIC_URL: z.string().url(),
    R2_KEY_PREFIX: z.string().min(1).default("cubby-dev"),
    USDA_API_URL: z.string().url().default("http://localhost:8080/"),
    UPC_LOOKUP_API_URL: z.string().url(),
    UPC_LOOKUP_API_KEY: z.string().min(1).optional(),
    BETTER_AUTH_SECRET: z.string().min(1),
    BETTER_AUTH_URL: z.string().url().optional(),
    // Personal instance: signup is closed unless this is explicitly "true".
    ALLOW_SIGNUP: z.enum(["true", "false"]).default("false"),
    // E2E-only (wrangler --var in e2e-global-setup): serve plain (non-Secure,
    // unprefixed) auth cookies so WebKit accepts them over http. See auth.ts.
    INSECURE_AUTH_COOKIES: z.enum(["true", "false"]).default("false"),
    // E2E-only: the harness shares one local Worker identity across the whole
    // suite, so Better Auth's production request limit would reject healthy
    // parallel browser traffic. Never enable this in a deployed Worker.
    E2E_AUTH_TEST_MODE: z.enum(["true", "false"]).default("false"),
    AI_GATEWAY_API_KEY: z.string().min(1).optional(),
    NOTION_API_KEY: z.string().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    PORT: z.coerce.number().int().positive().optional(),
  },

  clientPrefix: "VITE_",

  client: {},

  runtimeEnv: {
    // E2E_DATABASE_URL takes precedence - it won't be overwritten by Vite's .env loading
    DATABASE_URL: process.env.E2E_DATABASE_URL || process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_ENDPOINT: process.env.R2_ENDPOINT,
    R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
    R2_PUBLIC_URL: process.env.R2_PUBLIC_URL,
    R2_KEY_PREFIX: process.env.R2_KEY_PREFIX,
    USDA_API_URL: process.env.USDA_API_URL,
    UPC_LOOKUP_API_URL: process.env.UPC_LOOKUP_API_URL,
    UPC_LOOKUP_API_KEY: process.env.UPC_LOOKUP_API_KEY,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    ALLOW_SIGNUP: process.env.ALLOW_SIGNUP,
    INSECURE_AUTH_COOKIES: process.env.INSECURE_AUTH_COOKIES,
    E2E_AUTH_TEST_MODE: process.env.E2E_AUTH_TEST_MODE,
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
    NOTION_API_KEY: process.env.NOTION_API_KEY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    PORT: process.env.PORT,
  },

  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
