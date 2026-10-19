import { createAppError } from "~/server/errors/app-error";
import {
  PLAYBOOK_FILES,
  PLAYBOOK_SKILLS,
} from "~/server/generated/playbooks.gen";

/** Above this size an unsectioned read returns the outline, not the text. */
export const PLAYBOOK_READ_LIMIT = 40_000;

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces hyphenated. */
const headingSlug = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replaceAll(/\s/gu, "-");

/** Headings outside fenced code blocks, with their line index. */
function headings(lines: readonly string[]) {
  const found: { index: number; level: number; text: string }[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(?:```|~~~)/u.test(line)) fenced = !fenced;
    const match = fenced ? null : HEADING.exec(line);
    if (match?.[1] && match[2])
      found.push({ index, level: match[1].length, text: match[2] });
  });
  return found;
}

/** One section by anchor slug or heading text, through its last subsection. */
export function markdownSection(markdown: string, heading: string) {
  const lines = markdown.split("\n");
  const all = headings(lines);
  const wanted = headingSlug(heading.replace(/^#/u, ""));
  const start = all.findIndex((entry) => headingSlug(entry.text) === wanted);
  const head = all[start];
  if (!head) return null;
  const end = all
    .slice(start + 1)
    .find((entry) => entry.level <= head.level)?.index;
  return lines.slice(head.index, end).join("\n").trimEnd();
}

const outline = (markdown: string) =>
  headings(markdown.split("\n")).map(
    (entry) => `${"#".repeat(entry.level)} ${entry.text}`,
  );

export const listPlaybooks = () =>
  PLAYBOOK_SKILLS.map((skill) => ({ ...skill, files: [...skill.files] }));

export function getPlaybook(name: string) {
  const skill = listPlaybooks().find((entry) => entry.name === name);
  if (!skill)
    throw createAppError(
      "PLAYBOOK_NOT_FOUND",
      `No playbook ${name}; playbook.list names ${PLAYBOOK_SKILLS.map((entry) => entry.name).join(", ")}`,
    );
  return { ...skill, content: PLAYBOOK_FILES[skill.path] ?? "" };
}

export function readPlaybookFile(path: string, heading?: string) {
  const markdown = PLAYBOOK_FILES[path.replace(/^\.?\//u, "")];
  if (markdown === undefined)
    throw createAppError(
      "PLAYBOOK_NOT_FOUND",
      `${path} is not a playbook file; read paths linked from a playbook or listed in playbook.list files`,
    );
  if (heading) {
    const content = markdownSection(markdown, heading);
    if (content === null)
      throw createAppError(
        "PLAYBOOK_NOT_FOUND",
        `${path} has no heading ${heading}; its headings are:\n${outline(markdown).join("\n")}`,
      );
    return { path, heading, content, outline: null };
  }
  return markdown.length > PLAYBOOK_READ_LIMIT
    ? { path, heading: null, content: null, outline: outline(markdown) }
    : { path, heading: null, content: markdown, outline: null };
}
