import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assetRoles = {
  AccentColor: "interaction",
  Signal: "signal",
  Canvas: "canvas",
  Surface: "surface",
  Inset: "inset",
  Hairline: "hairline",
  Cook: "domain-cook",
  Pantry: "domain-pantry",
  Plan: "domain-plan",
  House: "domain-house",
  Finance: "domain-finance",
  Positive: "positive",
  Warning: "warning",
  Destructive: "destructive",
  Slate: "slate",
};

export function renderBrandCss(roles, aliases, values) {
  const lines = [
    "/* Generated from tokens.json. Edit the source and run pnpm generate. */",
    ":root {",
    ...Object.entries(roles).map(
      ([name, role]) => `  --brand-${name}: ${role.light.toLowerCase()};`,
    ),
    ...Object.entries(aliases).map(
      ([name, target]) => `  --brand-${name}: var(--brand-${target});`,
    ),
    ...Object.entries(values).map(([name, value]) =>
      ["font-heading", "font-sans", "font-mono"].includes(name)
        ? `  --brand-${name}:\n    ${value};`
        : `  --brand-${name}: ${value};`,
    ),
    "  --positive: var(--brand-positive);",
    "  --warning: var(--brand-warning);",
    "  --warning-ink: var(--brand-warning-ink);",
    "  --destructive: var(--brand-destructive);",
    "  --slate: var(--brand-slate);",
    "  --brand-elevation-popover: 0 12px 32px rgb(27 33 27 / 0.14);",
    "  --brand-focus-ring:\n    0 0 0 2px var(--brand-surface), 0 0 0 4px var(--brand-interaction);",
    "  --rule-ink: 1px solid var(--brand-hairline);",
    "}",
    "",
  ];
  return lines.join("\n");
}

function components(hex) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) throw new Error(`Invalid color ${hex}`);
  return Object.fromEntries(
    ["red", "green", "blue"].map((key, index) => [
      key,
      parseInt(hex.slice(index * 2 + 1, index * 2 + 3), 16) / 255,
    ]),
  );
}

export function renderColorAsset(role) {
  return `${JSON.stringify(
    {
      colors: [
        {
          idiom: "universal",
          color: {
            "color-space": "srgb",
            components: { ...components(role.light), alpha: 1 },
          },
        },
        {
          idiom: "universal",
          color: {
            "color-space": "srgb",
            components: { ...components(role.dark), alpha: 1 },
          },
          appearances: [{ appearance: "luminosity", value: "dark" }],
        },
      ],
      info: { author: "xcode", version: 1 },
    },
    null,
    2,
  )}\n`;
}

export function renderMetricsSwift(values) {
  const names = [
    "radius-control",
    "radius-panel",
    "radius-chip",
    "space-1",
    "space-2",
    "space-3",
    "space-4",
    "space-5",
    "space-6",
  ];
  const declarations = names.map((name) => {
    const value = values[name];
    if (!/^\d+px$/.test(value ?? ""))
      throw new Error(`Invalid metric ${name}: ${value}`);
    const identifier = name.replace(/-([a-z\d])/g, (_, letter) =>
      letter.toUpperCase(),
    );
    return `    static let ${identifier}: CGFloat = ${value.slice(0, -2)}`;
  });
  return [
    "// Generated from packages/design-tokens/tokens.json. Do not edit.",
    "import SwiftUI",
    "",
    "enum FieldGuideMetrics {",
    ...declarations,
    "",
    "    static func optionColor(_ token: String?) -> Color? {",
    "        switch token {",
    ...Object.entries(assetRoles).map(
      ([asset, role]) =>
        `        case "var(--${role})", "var(--brand-${role})": Color("${asset}")`,
    ),
    "        default: nil",
    "        }",
    "    }",
    "}",
    "",
  ].join("\n");
}

function sync(path, content, check) {
  if (check) {
    if (readFileSync(path, "utf8") !== content) {
      throw new Error(`Design token output is stale: ${path}`);
    }
  } else {
    writeFileSync(path, content);
  }
}

function main() {
  const { colors, aliases, values } = JSON.parse(
    readFileSync(join(root, "packages/design-tokens/tokens.json"), "utf8"),
  );
  const check = process.argv.includes("--check");
  sync(
    join(root, "packages/design-tokens/brand.css"),
    renderBrandCss(colors, aliases, values),
    check,
  );
  sync(
    join(root, "apps/apple/App/Shared/Theme/FieldGuideMetrics.swift"),
    renderMetricsSwift(values),
    check,
  );
  for (const [asset, role] of Object.entries(assetRoles)) {
    const path = join(
      root,
      `apps/apple/App/Assets.xcassets/${asset}.colorset/Contents.json`,
    );
    if (!check) mkdirSync(dirname(path), { recursive: true });
    sync(path, renderColorAsset(colors[role]), check);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
