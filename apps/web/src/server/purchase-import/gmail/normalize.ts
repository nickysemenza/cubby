import type {
  GmailHistoryPage,
  GmailHistoryRecord,
  GmailMessage,
  GmailMessagePart,
  GmailOrderMailAttachment,
  GmailOrderMailEvent,
  GmailNormalizedMessage,
  GmailHistoryEventKind,
} from "./types";

const asText = (data: string): string => {
  const normalized = data.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const byteLength = (data: string): number => {
  const normalized = data.replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=")
      ? 1
      : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
};

const headerRecord = (
  headers: readonly { name: string; value: string }[] | undefined,
) => {
  const result: Record<string, string> = {};
  for (const header of headers ?? []) {
    const key = header.name.trim().toLowerCase();
    if (!key) continue;
    const value = header.value.trim();
    result[key] = result[key] ? `${result[key]}, ${value}` : value;
  }
  return result;
};

const isoInternalDate = (internalDate: string | undefined): string | null => {
  if (!internalDate || !/^\d+$/u.test(internalDate)) return null;
  const parsed = new Date(Number(internalDate));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

type BodyState = { text: string | null; html: string | null };

// The branches deliberately mirror MIME's recursive body/attachment variants.
// eslint-disable-next-line complexity
const walkParts = (
  part: GmailMessagePart,
  path: string,
  body: BodyState,
  attachments: GmailOrderMailAttachment[],
  mailboxId: string,
  messageId: string,
): void => {
  for (const [index, child] of (part.parts ?? []).entries()) {
    walkParts(
      child,
      `${path}.${index}`,
      body,
      attachments,
      mailboxId,
      messageId,
    );
  }

  const mimeType = (part.mimeType ?? "").toLowerCase();
  const data = part.body?.data;
  const isAttachment = Boolean(part.filename || part.body?.attachmentId);

  if (
    !isAttachment &&
    data &&
    mimeType === "text/plain" &&
    body.text === null
  ) {
    body.text = asText(data);
  }
  if (!isAttachment && data && mimeType === "text/html" && body.html === null) {
    body.html = asText(data);
  }

  if (!isAttachment) return;
  const attachmentId = part.body?.attachmentId ?? null;
  const size = part.body?.size ?? (data ? byteLength(data) : 0);
  const attachment: GmailOrderMailAttachment = {
    sourceKey: `gmail:${mailboxId}:${messageId}:attachment:${part.partId ?? path}`,
    mailboxId,
    messageId,
    attachmentId,
    filename: part.filename?.trim() || "unnamed",
    mimeType: mimeType || "application/octet-stream",
    size,
  };
  if (data) attachment.dataBase64Url = data;
  attachments.push(attachment);
};

export const normalizeMessage = (
  mailboxId: string,
  message: GmailMessage,
): GmailNormalizedMessage => {
  if (!message.id.trim()) throw new Error("Gmail message id is required");
  const body: BodyState = { text: null, html: null };
  const attachments: GmailOrderMailAttachment[] = [];
  if (message.payload) {
    walkParts(message.payload, "0", body, attachments, mailboxId, message.id);
  }

  const dedupedAttachments = new Map(
    attachments.map((attachment) => [attachment.sourceKey, attachment]),
  );
  return {
    mail: {
      sourceKey: `gmail:${mailboxId}:${message.id}`,
      mailboxId,
      messageId: message.id,
      threadId: message.threadId ?? null,
      historyId: message.historyId ?? null,
      internalDate: isoInternalDate(message.internalDate),
      labelIds: [...new Set(message.labelIds ?? [])].sort(),
      headers: headerRecord(message.payload?.headers),
      snippet: message.snippet?.trim() || null,
      bodyText: body.text,
      bodyHtml: body.html,
    },
    attachments: [...dedupedAttachments.values()].sort((a, b) =>
      a.sourceKey.localeCompare(b.sourceKey),
    ),
  };
};

const eventEntries = (
  record: GmailHistoryRecord,
): readonly {
  kind: GmailHistoryEventKind;
  message: { id: string; threadId?: string };
  labelIds: readonly string[];
}[] => [
  ...(record.messagesAdded ?? []).map(({ message }) => ({
    kind: "message_added" as const,
    message,
    labelIds: [],
  })),
  ...(record.messagesDeleted ?? []).map(({ message }) => ({
    kind: "message_deleted" as const,
    message,
    labelIds: [],
  })),
  ...(record.labelsAdded ?? []).map(({ message, labelIds }) => ({
    kind: "labels_added" as const,
    message,
    labelIds: [...new Set(labelIds ?? [])].sort(),
  })),
  ...(record.labelsRemoved ?? []).map(({ message, labelIds }) => ({
    kind: "labels_removed" as const,
    message,
    labelIds: [...new Set(labelIds ?? [])].sort(),
  })),
];

export const normalizeHistoryPage = (
  mailboxId: string,
  page: GmailHistoryPage,
): GmailOrderMailEvent[] => {
  const events: GmailOrderMailEvent[] = [];
  for (const record of page.history ?? []) {
    const entries = eventEntries(record);
    entries.forEach((entry, index) => {
      if (!entry.message.id.trim()) return;
      events.push({
        sourceKey: `gmail:${mailboxId}:history:${record.id}:${index}`,
        mailboxId,
        historyId: record.id,
        messageId: entry.message.id,
        threadId: entry.message.threadId ?? null,
        kind: entry.kind,
        labelIds: entry.labelIds,
      });
    });
  }
  return events;
};

export const mergeAttachmentPayload = (
  attachment: GmailOrderMailAttachment,
  payload: { data?: string; size?: number },
): GmailOrderMailAttachment => {
  const merged: GmailOrderMailAttachment = {
    ...attachment,
    size:
      payload.size ??
      (payload.data ? byteLength(payload.data) : attachment.size),
  };
  if (payload.data) merged.dataBase64Url = payload.data;
  return merged;
};
