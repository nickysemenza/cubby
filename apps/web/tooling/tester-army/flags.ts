/**
 * Flags shared by both engines' entry points:
 * `--journey a,b` picks journeys, `--harness standard|coupled` picks the
 * journeys of one harness, `--wrong` (alias `--wrong-name`) corrupts
 * every final database expectation so the run must fail, `--replay` enables
 * the local replay cache.
 */
export function applyJourneyFlags(
  flags: string[],
  command: string,
  extra: string[] = [],
) {
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--replay") process.env.TESTER_ARMY_REPLAY = "1";
    else if (flag === "--wrong" || flag === "--wrong-name")
      process.env.TESTER_ARMY_WRONG = "1";
    else if (flag === "--journey") {
      const value = flags[(index += 1)];
      if (!value) throw new Error(`${command}: --journey needs an id list`);
      process.env.TESTER_ARMY_JOURNEYS = value;
    } else if (flag === "--harness") {
      const value = flags[(index += 1)];
      if (value !== "standard" && value !== "coupled")
        throw new Error(`${command}: --harness is standard or coupled`);
      process.env.TESTER_ARMY_HARNESS = value;
    } else if (!extra.includes(flag ?? ""))
      throw new Error(
        `Usage: ${command} [--journey a,b] [--harness standard|coupled] [--replay] [--wrong]`,
      );
  }
}
