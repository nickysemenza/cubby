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

/** The Apple Developer team that signs every Cubby app and fixture. */
export const APPLE_DEVELOPMENT_TEAM = "Y9A97FXT63";

/** The Mac import fixture's isolated identity, so e2e never touches the member's app data. */
export const APPLE_E2E_BUNDLE_IDENTIFIER = `${APPLE_APP_IDENTITIES.production.bundleIdentifier}.e2e`;

/** BGTaskScheduler identifiers; the iOS Info.plist permits exactly these. */
export const APPLE_BACKGROUND_TASK_IDENTIFIERS = {
  photoMatching: `${APPLE_APP_IDENTITIES.production.bundleIdentifier}.photo-matching`,
  librarySync: `${APPLE_APP_IDENTITIES.production.bundleIdentifier}.library-sync`,
  imageQueue: `${APPLE_APP_IDENTITIES.production.bundleIdentifier}.image-queue`,
} as const;

export const nativeCallbackSchemeSchema = z.enum([
  APPLE_APP_IDENTITIES.production.callbackScheme,
  APPLE_APP_IDENTITIES.development.callbackScheme,
]);
export type NativeCallbackScheme = z.infer<typeof nativeCallbackSchemeSchema>;
