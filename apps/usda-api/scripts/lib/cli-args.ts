export interface CliArgs {
  args: string[];
  getArg(name: string): string | undefined;
}

export function cliArgs(): CliArgs {
  const args = process.argv.slice(2);
  return {
    args,
    getArg(name) {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    },
  };
}
