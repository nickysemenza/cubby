export const withOptionalLimit = <const TConfig extends object>(
  config: TConfig,
  limit: number | undefined,
) => (limit === undefined ? config : { ...config, limit });
