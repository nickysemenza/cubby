import { runOrThrow } from "./lib/run.ts";

await runOrThrow(
  "pnpm",
  ["apple", "cli", "chatgpt", "connect", ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);
