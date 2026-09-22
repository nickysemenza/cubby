import { z } from "zod";

import { auditDateFilterFields } from "./base-entity";
import {
  generatedDeviceFieldSchemas,
  generatedDeviceFilterFields,
} from "./generated/entity-field-schemas.device.gen";
import { deviceShortcode, ledgerPartyShortcode } from "./identifiers";
import { createPaginatedResponseSchema, entityFilterList } from "./pagination";

export type { DevicePlatform } from "./device-fields";

export const deviceCreateInput = z.object(generatedDeviceFieldSchemas.create);
export type DeviceCreateInput = z.infer<typeof deviceCreateInput>;

export const deviceUpdateData = z.object(generatedDeviceFieldSchemas.update);
export type DeviceUpdateData = z.infer<typeof deviceUpdateData>;

export const deviceUpdateInput = z.object({
  id: deviceShortcode,
  data: deviceUpdateData,
});

export const deviceOut = z.object(generatedDeviceFieldSchemas.read);
export type DeviceOut = z.infer<typeof deviceOut>;

export const deviceListResponse = createPaginatedResponseSchema(deviceOut);

export const deviceFilterFields = {
  ...auditDateFilterFields,
  ...generatedDeviceFilterFields,
  ledgerPartyId: entityFilterList(ledgerPartyShortcode).optional(),
};
export const deviceFilters = z.object(deviceFilterFields);
export type DeviceFilters = z.infer<typeof deviceFilters>;
