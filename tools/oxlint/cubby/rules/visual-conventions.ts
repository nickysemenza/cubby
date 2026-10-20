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
  violates: (parts: string[][]) => boolean,
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
          violates(text.split(/\s+/u).filter(Boolean).map(utilityParts))
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
  utilityMatches(/^shadow-(?:sm|md|lg|xl|2xl|\[.*\])$/u),
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

export const noHandRolledPanelRule = visualRule(
  "Use the Panel component instead of combining rounded utilities and a panel border.",
  (parts) =>
    parts.some(
      (part) =>
        ownBox(part) &&
        /^rounded-(?!full$|none$|0$).+/u.test(part.at(-1) ?? ""),
    ) &&
    parts.some(
      (part) =>
        ownBox(part) && /^(?:border|border-border)$/u.test(part.at(-1) ?? ""),
    ),
  (node) => !FRAMED_NON_PANELS.has(owningElementName(node) ?? ""),
);
