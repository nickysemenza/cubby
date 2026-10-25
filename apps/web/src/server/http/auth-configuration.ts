import { z } from "zod";

import { env } from "~/env";
import { getAuthBindings } from "~/server/cf-env";

const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const authConfigurationSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: optionalUrl,
  CUBBY_DEV_ORIGIN_ALIASES: optionalText,
  NODE_ENV: z.enum(["development", "test", "production"]),
  ALLOW_SIGNUP: z.enum(["true", "false"]).default("false"),
  INSECURE_AUTH_COOKIES: z.enum(["true", "false"]).default("false"),
  E2E_AUTH_TEST_MODE: z.enum(["true", "false"]).default("false"),
  E2E_GOOGLE_PROVIDER_URL: optionalUrl,
  GOOGLE_CLIENT_ID: optionalText,
  GOOGLE_CLIENT_SECRET: optionalText,
});

export type AuthConfiguration = z.infer<typeof authConfigurationSchema>;

/** Worker bindings are authoritative, including absent optional settings after rotation.
 * Only Node callers outside a binding scope use the process-derived env snapshot. */
export function getAuthConfiguration(): AuthConfiguration {
  const bindings = getAuthBindings();
  return authConfigurationSchema.parse(
    bindings
      ? { ...bindings, NODE_ENV: bindings.NODE_ENV ?? env.NODE_ENV }
      : env,
  );
}

export const getAuthSecret = () => getAuthConfiguration().BETTER_AUTH_SECRET;

export function sameAuthConfiguration(
  a: AuthConfiguration,
  b: AuthConfiguration,
) {
  return authConfigurationSchema
    .keyof()
    .options.every((key) => a[key] === b[key]);
}
