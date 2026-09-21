#!/usr/bin/env bash
# Prints the UDID of the simulator to test on: the booted iPhone if any, else the
# first available iPhone (the same rule as scripts/apple.ts's `sim` command).
# Shared by scripts/apple-check.sh's `ci` mode and the CI job that pre-boots it.
set -euo pipefail
simulators_json="$(xcrun simctl list devices available -j)"
SIMULATORS_JSON="$simulators_json" node -e '
  const devices = Object.values(JSON.parse(process.env.SIMULATORS_JSON).devices).flat();
  const iphones = devices.filter((d) => d.name.includes("iPhone"));
  const chosen = iphones.find((d) => d.state === "Booted") ?? iphones[0];
  if (!chosen) {
    process.stderr.write("no available iPhone simulator\n");
    process.exit(1);
  }
  process.stdout.write(chosen.udid);
'
