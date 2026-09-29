import { deviceOut } from "./generated/device.gen";
import { createPaginatedResponseSchema } from "./pagination";

export {
  deviceCreateInput,
  deviceFilterFields,
  deviceFilters,
  deviceOut,
  deviceUpdateData,
  deviceUpdateInput,
  type DeviceCreateInput,
  type DeviceFilters,
  type DeviceOut,
  type DeviceUpdateData,
} from "./generated/device.gen";
export type { DevicePlatform } from "./device-fields";

export const deviceListResponse = createPaginatedResponseSchema(deviceOut);
