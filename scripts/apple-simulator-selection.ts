import type { SimulatorInventory } from "../apps/web/tooling/simulator-inventory-schema.ts";

export const iosSimulatorDeviceType =
  "com.apple.CoreSimulator.SimDeviceType.iPhone-17";

// Type-only imports keep this available before pnpm installs dependencies.
export function selectIOSSimulator(
  inventory: SimulatorInventory,
  preferred?: string,
) {
  const phones = Object.entries(inventory.devices)
    .filter(([runtime]) => runtime.includes(".iOS-"))
    .flatMap(([runtime, devices]) =>
      devices.map((device) => ({ ...device, runtime })),
    )
    .filter(
      (device) =>
        device.name.includes("iPhone") &&
        device.deviceTypeIdentifier === iosSimulatorDeviceType,
    );
  return preferred
    ? phones.find(
        (device) => device.name === preferred || device.udid === preferred,
      )
    : (phones.find((device) => device.state === "Booted") ?? phones[0]);
}
