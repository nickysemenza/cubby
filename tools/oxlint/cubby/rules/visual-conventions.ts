import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
  classNameText,
  isClassBuilder,
  isClassRecipe,
} from "./generic-paths.ts";

/** Split variants only outside arbitrary selectors/values (which can contain colons). */
function utilityParts(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const char = token[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "[" || char === "(") depth++;
    if (char === "]" || char === ")") depth--;
    if (char === ":" && depth === 0) {
      parts.push(token.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(token.slice(start).replace(/^!|!$/gu, ""));
  return parts;
}

/** The outer class expression owns reporting, even when builders nest. */
function hasClassParent(node: ESTree.Node): boolean {
  let parent: ESTree.Node | null = node.parent;
  while (parent) {
    if (isClassBuilder(parent) || isClassRecipe(parent)) return true;
    if (
      parent.type === "JSXAttribute" &&
      parent.name.type === "JSXIdentifier" &&
      parent.name.name === "className"
    )
      return true;
    parent = parent.parent;
  }
  return false;
}

type ClassNode =
  | ESTree.JSXOpeningElement
  | ESTree.CallExpression
  | Extract<ESTree.Node, { type: "Property" }>
  | ESTree.VariableDeclarator;

function visualRule(
  message: string,
  violates: (parts: string[][], node: ClassNode) => boolean,
  appliesTo: (node: ClassNode) => boolean = () => true,
) {
  return defineRule({
    meta: {
      type: "suggestion",
      docs: { description: message },
      messages: { convention: `${message} See apps/web/DESIGN.md.` },
    },
    createOnce(context) {
      function check(node: ClassNode) {
        if (
          node.type !== "JSXOpeningElement" &&
          (!(isClassBuilder(node) || isClassRecipe(node)) ||
            hasClassParent(node))
        )
          return;
        if (!appliesTo(node)) return;
        const text = classNameText(node);
        if (
          text &&
          violates(text.split(/\s+/u).filter(Boolean).map(utilityParts), node)
        )
          context.report({ node, messageId: "convention" });
      }
      return {
        JSXOpeningElement: check,
        CallExpression: check,
        Property: check,
        VariableDeclarator: check,
      };
    },
  });
}

const utilityMatches = (pattern: RegExp) => (parts: string[][]) =>
  parts.some((part) => pattern.test(part.at(-1) ?? ""));

export const noUppercaseUtilityRule = visualRule(
  "Use sentence case and text-xs font-medium labels instead of uppercase.",
  utilityMatches(/^uppercase$/u),
);
export const noLargeRadiusRule = visualRule(
  "Use rounded-md or rounded-lg instead of rounded-xl, rounded-2xl or rounded-3xl (including directional variants).",
  utilityMatches(
    /^rounded-(?:(?:[trblse]|tl|tr|bl|br|ss|se|es|ee)-)?(?:xl|2xl|3xl)$/u,
  ),
);
export const noShadowUtilityRule = visualRule(
  "Use flat surfaces and hairlines instead of shadow utilities; floating primitives use --brand-elevation-popover with an explicit lint exception.",
  utilityMatches(
    /^shadow(?!(?:-none)$)(?:$|-(?:2xs|xs|sm|md|lg|xl|2xl|inner|\[.*\]|\(--[^)]+\)))$/u,
  ),
);
export const noArbitraryFontSizeRule = visualRule(
  "Use the type scale classes (text-3xs, text-2xs, text-xs, text-sm, text-base, text-lg, text-xl) instead of arbitrary font sizes.",
  utilityMatches(/^text-\[(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em)\](?:\/.*)?$/u),
);
export const noDarkVariantRule = visualRule(
  "Use the shared light theme; Cubby has no dark mode, so remove dark: variants.",
  (parts) => parts.some((part) => part.slice(0, -1).includes("dark")),
);
/** The JSX element whose `className` holds this class expression, if any. */
function owningElementName(node: ClassNode): string | null {
  let current: ESTree.Node | null = node;
  while (current) {
    if (current.type === "JSXOpeningElement") {
      const { name } = current;
      if (name.type === "JSXIdentifier") return name.name;
      if (name.type === "JSXMemberExpression") return name.property.name;
      return null;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Controls, media and inline chips own their frame; a panel is a block that
 * holds content, so only those are steered to `Panel`.
 */
const FRAMED_NON_PANELS = new Set([
  "img",
  "Image",
  "input",
  "textarea",
  "select",
  "kbd",
  "code",
  "span",
  "button",
  "Button",
  "label",
]);

/** Descendant selectors (`[&_pre]:border`) style children, not this box. */
const ownBox = (part: string[]) =>
  !part.slice(0, -1).some((variant) => variant.startsWith("["));

interface PanelClassPresence {
  rounded: boolean;
  border: boolean;
}

const NO_PANEL_CLASSES: PanelClassPresence = { rounded: false, border: false };

function combinePanelClasses(
  left: PanelClassPresence[],
  right: PanelClassPresence[],
): PanelClassPresence[] {
  const combinations = new Map<string, PanelClassPresence>();
  for (const first of left) {
    for (const second of right) {
      const combination = {
        rounded: first.rounded || second.rounded,
        border: first.border || second.border,
      };
      combinations.set(
        `${combination.rounded}:${combination.border}`,
        combination,
      );
    }
  }
  return [...combinations.values()];
}

function panelClassesInText(text: string): PanelClassPresence[] {
  const parts = text.split(/\s+/u).filter(Boolean).map(utilityParts);
  return [
    {
      rounded: parts.some(
        (part) =>
          ownBox(part) &&
          /^rounded-(?!full$|none$|0$).+/u.test(part.at(-1) ?? ""),
      ),
      border: parts.some(
        (part) =>
          ownBox(part) && /^(?:border|border-border)$/u.test(part.at(-1) ?? ""),
      ),
    },
  ];
}

/** Keep mutually exclusive class expressions separate for the panel check. */
function panelClassCombinations(node: ESTree.Node): PanelClassPresence[] {
  const fromText = (value: ESTree.Node) =>
    panelClassesInText(classNameText(value) ?? "");
  switch (node.type) {
    case "JSXOpeningElement":
      return node.attributes
        .filter(
          (attribute) =>
            attribute.type === "JSXAttribute" &&
            attribute.name.type === "JSXIdentifier" &&
            attribute.name.name === "className",
        )
        .reduce(
          (combinations, attribute) =>
            combinePanelClasses(
              combinations,
              panelClassCombinations(attribute),
            ),
          [NO_PANEL_CLASSES],
        );
    case "JSXAttribute":
      return node.value
        ? panelClassCombinations(node.value)
        : [NO_PANEL_CLASSES];
    case "JSXExpressionContainer":
      return panelClassCombinations(node.expression);
    case "ConditionalExpression":
      return [
        ...panelClassCombinations(node.consequent),
        ...panelClassCombinations(node.alternate),
      ];
    case "LogicalExpression":
      return node.operator === "&&"
        ? [NO_PANEL_CLASSES, ...panelClassCombinations(node.right)]
        : [
            ...panelClassCombinations(node.left),
            ...panelClassCombinations(node.right),
          ];
    case "TemplateLiteral": {
      const staticText = node.quasis
        .map((part, index) => {
          let value = part.value.cooked ?? part.value.raw;
          if (index > 0) value = value.replace(/^\S+/u, "");
          if (index < node.quasis.length - 1)
            value = value.replace(/\S+$/u, "");
          return value;
        })
        .join(" ");
      return node.expressions.reduce(
        (combinations, expression) =>
          combinePanelClasses(combinations, panelClassCombinations(expression)),
        panelClassesInText(staticText),
      );
    }
    case "ArrayExpression":
      return node.elements.reduce(
        (combinations, element) =>
          combinePanelClasses(
            combinations,
            element ? panelClassCombinations(element) : [NO_PANEL_CLASSES],
          ),
        [NO_PANEL_CLASSES],
      );
    case "CallExpression":
      return isClassBuilder(node) &&
        !(node.callee.type === "Identifier" && node.callee.name === "cva")
        ? node.arguments.reduce(
            (combinations, argument) =>
              combinePanelClasses(
                combinations,
                panelClassCombinations(argument),
              ),
            [NO_PANEL_CLASSES],
          )
        : fromText(node);
    case "ArrowFunctionExpression":
      return panelClassCombinations(node.body);
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSTypeAssertion":
    case "ParenthesizedExpression":
      return panelClassCombinations(node.expression);
    default:
      return fromText(node);
  }
}

export const noHandRolledPanelRule = visualRule(
  "Use the Panel component instead of combining rounded utilities and a panel border.",
  (_parts, node) =>
    panelClassCombinations(node).some(
      (combination) => combination.rounded && combination.border,
    ),
  (node) => !FRAMED_NON_PANELS.has(owningElementName(node) ?? ""),
);
