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
  if (
    !raw ||
    command !== "pnpm" ||
    args[0] !== "exec" ||
    args[1] !== "agent-device"
  )
    return { command, args };
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
  const body = args.slice(2);
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
