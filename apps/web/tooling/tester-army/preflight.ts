import { preflightTesterArmyModel } from "./model";

process.env.E2E_TELEMETRY_DISABLED = "1";
await preflightTesterArmyModel();
