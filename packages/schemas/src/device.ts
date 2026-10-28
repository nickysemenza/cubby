import { deviceOut } from "@cubby/schemas/entities/device";
import { createPaginatedResponseSchema } from "./pagination";

export type { DevicePlatform } from "./device-fields";

export const deviceListResponse = createPaginatedResponseSchema(deviceOut);
