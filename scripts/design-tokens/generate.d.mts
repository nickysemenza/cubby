type ColorRole = { light: string; dark: string };

export declare function renderBrandCss(
  roles: Record<string, ColorRole>,
  aliases: Record<string, string>,
  values: Record<string, string>,
): string;

export declare function renderColorAsset(role: ColorRole): string;

export declare function renderMetricsSwift(
  values: Record<string, string>,
): string;
