import {
  APPLE_APP_IDENTITIES,
  nativeCallbackSchemeSchema,
  type NativeCallbackScheme,
} from "@cubby/shared/apple-app-identity";
import { z } from "zod";

import { urlStringParam } from "./search-params";

export const nativeAuthSearch = z.object({
  state: urlStringParam,
  code_challenge: urlStringParam,
  code_challenge_method: urlStringParam,
  callback_scheme: nativeCallbackSchemeSchema.default(
    APPLE_APP_IDENTITIES.production.callbackScheme,
  ),
  complete: z.boolean().optional().catch(undefined),
  google_error: z.boolean().optional().catch(undefined),
});

export const nativeAuthDefaults = {
  state: undefined,
  code_challenge: undefined,
  code_challenge_method: undefined,
  callback_scheme: APPLE_APP_IDENTITIES.production.callbackScheme,
  complete: undefined,
  google_error: undefined,
} as const;

export function nativeAuthCallbackURLs(
  scheme: NativeCallbackScheme,
  state: string,
  codeChallenge: string,
) {
  return {
    callbackURL: `/auth/native?${new URLSearchParams({ complete: "true", callback_scheme: scheme })}`,
    errorCallbackURL: `/auth/native?${new URLSearchParams({ google_error: "true", callback_scheme: scheme, state, code_challenge: codeChallenge, code_challenge_method: "S256" })}`,
  };
}
