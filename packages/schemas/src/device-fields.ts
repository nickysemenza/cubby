import { z } from "zod";

/** The native platform one install of the companion app runs on. */
export const devicePlatform = z.enum(["ios", "macos"]);
export type DevicePlatform = z.infer<typeof devicePlatform>;
