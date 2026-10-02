// An early boot must pick the same iPhone as the harness, respect explicit
// device choices and never fall back to a different device when one is missing.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { selectIOSSimulator } from "./apple-simulator-selection.ts";

const phoneType = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
const phone = (name: string, udid: string, state = "Shutdown") => ({
  name,
  udid,
  state,
  deviceTypeIdentifier: phoneType,
});
const inventory = {
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      phone("Synthetic iPhone 17 A", "00000000-0000-0000-0000-000000000001"),
      phone(
        "Synthetic iPhone 17 B",
        "00000000-0000-0000-0000-000000000002",
        "Booted",
      ),
      {
        ...phone("Synthetic iPhone 16", "00000000-0000-0000-0000-000000000003"),
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.tvOS-26-0": [
      phone(
        "Synthetic iPhone 17 Wrong Runtime",
        "00000000-0000-0000-0000-000000000004",
        "Booted",
      ),
    ],
  },
};

test("uses the already booted matching iPhone, then a shutdown matching iPhone", () => {
  assert.equal(selectIOSSimulator(inventory)?.name, "Synthetic iPhone 17 B");
  const shutdown = structuredClone(inventory);
  shutdown.devices["com.apple.CoreSimulator.SimRuntime.iOS-26-0"][1]!.state =
    "Shutdown";
  assert.equal(selectIOSSimulator(shutdown)?.name, "Synthetic iPhone 17 A");
});

test("honors a preferred name or UDID without silently selecting another phone", () => {
  assert.equal(
    selectIOSSimulator(inventory, "Synthetic iPhone 17 A")?.udid,
    "00000000-0000-0000-0000-000000000001",
  );
  assert.equal(
    selectIOSSimulator(inventory, "00000000-0000-0000-0000-000000000001")?.name,
    "Synthetic iPhone 17 A",
  );
  assert.equal(
    selectIOSSimulator(inventory, "Synthetic missing phone"),
    undefined,
  );
  assert.equal(selectIOSSimulator(inventory, "Synthetic iPhone 16"), undefined);
  assert.equal(selectIOSSimulator({ devices: {} }), undefined);
});
