import { z } from "zod";

export const APPLE_APP_IDENTITIES = {
  production: {
    bundleIdentifier: "com.nickysemenza.cubby",
    productName: "Cubby",
    callbackScheme: "cubby",
  },
  development: {
    bundleIdentifier: "com.nickysemenza.cubby.dev",
    productName: "Cubby Dev",
    callbackScheme: "cubby-dev",
  },
} as const;

export const nativeCallbackSchemeSchema = z.enum([
  APPLE_APP_IDENTITIES.production.callbackScheme,
  APPLE_APP_IDENTITIES.development.callbackScheme,
]);
export type NativeCallbackScheme = z.infer<typeof nativeCallbackSchemeSchema>;
