function kebabCase(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

export const brandColors = {
  foreground: "#3a3530",
  terracotta: "#c2603d",
  terraLight: "#d98a68",
  cream: "#fdfbf7",
  shelf: "#5c5550",
} as const;

export const semanticColors = {
  background: brandColors.cream,
  primary: brandColors.terracotta,
  primaryForeground: brandColors.cream,
  destructive: "#8b2020",
  border: "#e5ddd4",
  muted: "#f0ebe4",
  mutedForeground: brandColors.shelf,
} as const;

export const colors = { ...brandColors, ...semanticColors } as const;

/** CSS custom properties string for web injection into :root */
export const brandCssVars = Object.entries(brandColors)
  .map(([key, val]) => `--brand-${kebabCase(key)}: ${val};`)
  .join("\n  ");
