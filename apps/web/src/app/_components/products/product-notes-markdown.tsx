import type { ImageOut } from "@cubby/schemas/image";
import type { FC } from "react";

import {
  clean,
  type ElementProps,
  MarkdownText,
  markdownAnchorClass,
} from "~/components/markdown";
import { pageFromManualHref, resolveWikiLinks } from "~/lib/manual-wiki-links";

/**
 * Product notes with Obsidian-style [[wiki links]] resolved against the
 * attached PDF manuals (syntax + resolution in ~/lib/manual-wiki-links).
 * Resolved links click-jump the inline Manuals viewer via onManualLink;
 * cmd/ctrl/middle-click keeps the browser's native open-in-new-tab (the href
 * is the real PDF URL with a #page fragment). Unresolved targets render as
 * their literal [[...]] text, like Obsidian's unresolved links.
 */
export const ProductNotesMarkdown: FC<{
  notes: string;
  documents: ImageOut[];
  onManualLink?: (documentId: string, page: number) => void;
}> = ({ notes, documents, onManualLink }) => {
  return (
    <MarkdownText
      componentOverrides={{
        a: (props: ElementProps<"a">) => {
          const { children, href, ...rest } = clean(props);
          const doc = href
            ? documents.find(
                (d) => href === d.url || href.startsWith(`${d.url}#`),
              )
            : undefined;
          if (doc && onManualLink) {
            // No target=_blank: plain click jumps the inline viewer; modified
            // clicks (cmd/ctrl/middle/shift) fall through to the browser.
            return (
              <a
                {...rest}
                href={href}
                className={markdownAnchorClass}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                  e.preventDefault();
                  onManualLink(doc.id, pageFromManualHref(href ?? ""));
                }}
              >
                {children}
              </a>
            );
          }
          return (
            <a
              {...rest}
              href={href}
              className={markdownAnchorClass}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          );
        },
      }}
    >
      {resolveWikiLinks(notes, documents)}
    </MarkdownText>
  );
};
