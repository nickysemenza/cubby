/**
 * Flags shared by both engines' entry points:
 * `--journey a,b` picks journeys, `--wrong` (alias `--wrong-name`) corrupts
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
    } else if (!extra.includes(flag ?? ""))
      throw new Error(`Usage: ${command} [--journey a,b] [--replay] [--wrong]`);
  }
}
