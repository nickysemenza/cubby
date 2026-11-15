import { z } from "zod";

/** The native platform one install of the companion app runs on. */
export const devicePlatform = z.enum(["ios", "macos"]);

/** Private install credential, bound to the authenticated login and one registration generation. */
export const devicePushRegistration = z.object({
  userId: z.string(),
  sessionId: z.string(),
  token: z.string().regex(/^[a-f0-9]{32,512}$/),
  environment: z.enum(["development", "production"]),
  appIdentity: z.enum(["development", "production"]),
  generation: z.uuid(),
});
export type DevicePushRegistration = z.infer<typeof devicePushRegistration>;

/** @public Register this authenticated install for app alerts. */
export const devicePushRegisterInput = devicePushRegistration
  .pick({ token: true, environment: true, appIdentity: true })
  .extend({ enabled: z.boolean() });
/** @public Registration acknowledgement; never contains a push credential. */
export const devicePushRegisterOutput = z.object({ registered: z.boolean() });
