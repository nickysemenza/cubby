import {
  LEGACY_SHORTCODE_PREFIX,
  parseShortcode,
  SHORTCODE_BODY_LENGTH,
  SHORTCODE_CHARS,
  SHORTCODE_PREFIX,
} from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { entityDetailLink, isBrowserRoutedEntity } from "~/entities/entities";

const prefixes = [
  ...Object.values(SHORTCODE_PREFIX),
  ...Object.keys(LEGACY_SHORTCODE_PREFIX),
].map((prefix) => prefix.slice(0, -1));
const candidate = new RegExp(
  `(^|[^A-Z0-9_/-])((?:${prefixes.join("|")})-[${SHORTCODE_CHARS}]{${SHORTCODE_BODY_LENGTH}})(?![A-Z0-9_-])`,
  "gi",
);

/** Link shortcode tokens in displayed prose, while leaving surrounding text intact. */
export function ShortcodeProse({ children }: { children: string }): ReactNode {
  const parts: ReactNode[] = [];
  let end = 0;
  for (const match of children.matchAll(candidate)) {
    const code = match[2];
    if (!code || match.index === undefined) continue;
    const start = match.index + (match[1]?.length ?? 0);
    const parsed = parseShortcode(code);
    if (!parsed || !isBrowserRoutedEntity(parsed.type)) continue;
    if (start > end) parts.push(children.slice(end, start));
    parts.push(
      <Link
        key={start}
        {...entityDetailLink(parsed.type, parsed.shortcode)}
        className="text-primary underline underline-offset-2 hover:text-primary/80"
        onClick={(event) => event.stopPropagation()}
      >
        {code}
      </Link>,
    );
    end = start + code.length;
  }
  if (end === 0) return children;
  if (end < children.length) parts.push(children.slice(end));
  return <>{parts}</>;
}
