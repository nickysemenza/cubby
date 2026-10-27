import { z } from "zod";

const sharedDriver = z.object({
  command: z.string().min(1),
  targetArgs: z.array(z.string()),
});

/** Reuse the launcher's returned host/session binding; the harness owns neither
 * that daemon nor its session. Ordinary CI runs keep their dedicated driver. */
export function sharedDeviceCommand(
  command: string,
  args: string[],
  env = process.env,
) {
  const raw = env.CUBBY_E2E_AGENT_DEVICE;
  const deviceCommand =
    command === "pnpm" && args[0] === "exec" && args[1] === "agent-device";
  const simulatorCommand = command === "xcrun" && args[0] === "simctl";
  if (!raw || (!deviceCommand && !simulatorCommand)) return { command, args };
  const driver = sharedDriver.parse(JSON.parse(raw));
  const value = (flag: string) =>
    driver.targetArgs[driver.targetArgs.indexOf(flag) + 1];
  for (const flag of ["--platform", "--udid", "--config", "--session"]) {
    if (
      !driver.targetArgs.includes(flag) ||
      !value(flag) ||
      value(flag)!.startsWith("--")
    )
      throw new Error(`Shared device driver needs ${flag}`);
  }
  if (value("--platform") !== "ios")
    throw new Error("Simulator shared driver must target an iOS device");
  if (simulatorCommand) {
    const action = args[1];
    // device_open already booted the shared target; lifecycle stays in its session.
    if (action === "boot" || action === "bootstatus") {
      if (args[2] !== value("--udid"))
        throw new Error("Shared driver targets a different device");
      return undefined;
    }
    if (action === "install" || action === "uninstall") {
      if (args[2] !== value("--udid"))
        throw new Error("Shared driver targets a different device");
      const body =
        action === "install"
          ? ["install", "com.nickysemenza.cubby", args[3]!]
          : ["uninstall", args[3]!];
      return { command: driver.command, args: [...body, ...driver.targetArgs] };
    }
    if (action === "launch") {
      const offset = args[2] === "--terminate-running-process" ? 3 : 2;
      if (args[offset] !== value("--udid"))
        throw new Error("Shared driver targets a different device");
      const body = [
        "open",
        args[offset + 1]!,
        "--relaunch",
        ...args.slice(offset + 2).flatMap((arg) => ["--launch-args", arg]),
      ];
      return { command: driver.command, args: [...body, ...driver.targetArgs] };
    }
    if (action === "io" && args[3] === "screenshot") {
      if (args[2] !== value("--udid"))
        throw new Error("Shared driver targets a different device");
      return {
        command: driver.command,
        args: ["screenshot", args[4]!, ...driver.targetArgs],
      };
    }
    return { command, args };
  }
  const body = sharedReplayBody(args.slice(2));
  if (body[0] === "close" || (body[0] === "daemon" && body[1] === "stop"))
    return undefined;
  const scoped: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const argument = body[i]!;
    if (
      ["--platform", "--udid", "--config", "--session", "--state-dir"].includes(
        argument,
      )
    ) {
      const supplied = body[++i];
      if (!supplied)
        throw new Error(`Device command needs a value for ${argument}`);
      if (
        (argument === "--udid" || argument === "--platform") &&
        supplied !== value(argument)
      )
        throw new Error("Shared driver targets a different device");
    } else scoped.push(argument);
  }
  return { command: driver.command, args: [...scoped, ...driver.targetArgs] };
}

function sharedReplayBody(body: string[]) {
  if (body[0] !== "test") return body;
  const file = body[1];
  if (!file || !/\.(ad|ya?ml)$/.test(file))
    throw new Error("Shared device journeys need one explicit replay file");
  // `test` forks a session per attempt and conflicts with the panel's active
  // session. Single-file replay keeps the returned session and daemon alive.
  // A replay is one daemon request; retain enough time for the full native journey.
  const replay = [
    "replay",
    file,
    ...(body.includes("--timeout") ? [] : ["--timeout", "240000"]),
  ];
  for (let i = 2; i < body.length; i++) {
    const argument = body[i]!;
    if (
      ["--reporter", "--report-junit", "--artifacts-dir", "--retries"].includes(
        argument,
      )
    ) {
      const supplied = body[++i];
      if (!supplied || (argument === "--retries" && supplied !== "0"))
        throw new Error(
          "Shared replay requires a zero-retry single-file journey",
        );
    } else replay.push(argument);
  }
  return replay;
}
