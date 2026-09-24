import type { ImageOut } from "@cubby/schemas/image";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import prettyBytes from "pretty-bytes";
import { type FC, useEffect, useRef } from "react";

import { Row, Stack } from "~/components/layout";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

/**
 * The minimum a PDF viewer actually needs. Deliberately NOT the full `ImageOut`:
 * a purchase's `images` are a `{id,url,filename,contentType}` summary (a vendor event's
 * filed invoice), and demanding `key`/`size`/`status`/timestamps here forced that
 * caller into a per-document detail round-trip just to satisfy the type.
 * `size` stays optional and the byte chip hides when it's absent.
 */
export type ViewableDocument = Pick<ImageOut, "id" | "url" | "filename"> & {
  size?: number;
};

/**
 * A wiki-link jump request from the notes (see ProductNotesMarkdown). `nonce`
 * makes repeat clicks on the same link re-trigger the scroll effect.
 */
export interface DocumentViewTarget {
  documentId: string;
  page: number;
  nonce: number;
}

const BASE_VIEWER_PARAMS = "toolbar=0&navpanes=0&view=FitH&zoom=page-width";

const DocumentViewer: FC<{
  doc: ViewableDocument;
  target: DocumentViewTarget | null;
}> = ({ doc, target }) => {
  const containerRef = useRef<HTMLElement>(null);
  const active = target?.documentId === doc.id ? target : null;

  // Scroll the viewer into view on each jump (nonce changes per click).
  useEffect(() => {
    if (active) {
      containerRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [active]);

  // Fragment params tame Chromium's built-in viewer: no toolbar, no thumbnail
  // sidebar, fit page to width. Firefox honors the zoom param; Safari ignores
  // them harmlessly. Download/print live behind the Open button. A jump target
  // prepends #page=N.
  const src = `${doc.url}#${
    active ? `page=${active.page}&` : ""
  }${BASE_VIEWER_PARAMS}`;

  // PDF open params are only parsed at document load — a fragment-only src
  // change is an in-document navigation the viewer ignores. Remount the iframe
  // (key) on every jump so the #page param actually takes effect; the PDF
  // re-fetch hits the browser cache (R2 serves an ETag).
  const iframeKey = active ? `jump-${active.nonce}` : "base";

  return (
    <Stack gap="xs" ref={containerRef} className="scroll-mt-16">
      <Row align="center" gap="sm" className="min-w-0">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {doc.filename}
        </span>
        {doc.size !== undefined && doc.size > 0 && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {prettyBytes(doc.size)}
          </span>
        )}
        <a
          href={doc.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "shrink-0",
          )}
        >
          <ArrowSquareOutIcon className="mr-1 size-3" />
          Open
        </a>
      </Row>
      {/* oxlint-disable-next-line react/iframe-missing-sandbox -- Native previews require browser document rendering; the source is a trusted Cubby object URL. */}
      <iframe
        key={iframeKey}
        src={src}
        title={doc.filename}
        loading="lazy"
        className="h-96 w-full border border-[var(--border)] bg-card sm:h-[44rem]"
      />
    </Stack>
  );
};

/**
 * Inline viewers for a set of attached PDF documents — originally a product's
 * manuals, now also a Purchase's filed invoices (see `ViewableDocument`).
 *
 * <iframe> over <object>/<embed>: all three invoke the same native PDF viewer
 * on desktop, but <object>'s fallback detection is unreliable in Chromium and
 * <embed> has none — with an always-visible Open link the fallback is moot.
 *
 * iOS Safari (incl. the installed PWA) renders only page 1 of any embedded
 * PDF, non-scrollable — a long-standing WebKit limitation with no HTML-only
 * workaround. There, the embed is a first-page preview and "Open" is the real
 * reading path (target=_blank opens the in-app sheet with Safari's full
 * viewer; never navigate top-level to the PDF — standalone mode has no back
 * bar, which would strand the user).
 */
export const DocumentViewerList: FC<{
  documents: ViewableDocument[];
  target?: DocumentViewTarget | null;
}> = ({ documents, target = null }) => {
  return (
    <Stack gap="md">
      {documents.map((doc) => (
        <DocumentViewer key={doc.id} doc={doc} target={target} />
      ))}
    </Stack>
  );
};
