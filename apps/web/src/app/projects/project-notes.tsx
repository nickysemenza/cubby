import { MarkdownText } from "~/components/markdown";
import { Description } from "~/components/ui/description";

/**
 * Renders a project's freeform `notes` field (plain markdown, DB-backed) —
 * successor of `NotionPageContent`'s block-tree walker, which rendered the
 * Notion page body block-by-block. `notes` is a single markdown string now,
 * so this is just the shared markdown renderer.
 */
export function ProjectNotes({ notes }: { notes: string | null }) {
  if (!notes || notes.trim().length === 0) {
    return <Description>No notes yet.</Description>;
  }

  return <MarkdownText className="text-sm">{notes}</MarkdownText>;
}
