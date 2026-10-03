import { execFileSync } from "node:child_process";

import { selectIOSSimulator } from "./apple-simulator-selection.ts";

const inventory = JSON.parse(
  execFileSync("xcrun", ["simctl", "list", "devices", "available", "-j"], {
    encoding: "utf8",
  }),
);
const device = selectIOSSimulator(inventory, process.env.CUBBY_SIM_DEVICE);
if (device && device.state !== "Booted") {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(device.udid))
    throw new Error("Simulator inventory returned an invalid device ID");
  console.log("[sim-prewarm] Starting simulator boot before Apple tool setup");
  execFileSync("xcrun", ["simctl", "boot", device.udid], {
    stdio: "inherit",
    timeout: 300_000,
  });
}
