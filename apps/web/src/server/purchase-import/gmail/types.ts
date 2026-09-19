/**
 * Small, provider-owned Gmail shapes. These intentionally mirror only the
 * fields the import pipeline needs; Google response objects must not leak
 * through the domain boundary.
 */

export type GmailHistoryEventKind =
  | "message_added"
  | "message_deleted"
  | "labels_added"
  | "labels_removed";

type GmailHeader = { name: string; value: string };

export type GmailMessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: readonly GmailHeader[];
  body?: {
    attachmentId?: string;
    data?: string;
    size?: number;
  };
  parts?: readonly GmailMessagePart[];
};

export type GmailMessage = {
  id: string;
  threadId?: string;
  historyId?: string;
  internalDate?: string;
  labelIds?: readonly string[];
  snippet?: string;
  payload?: GmailMessagePart;
};

type GmailMessageRef = Pick<GmailMessage, "id" | "threadId" | "historyId">;

export type GmailHistoryRecord = {
  id: string;
  messagesAdded?: readonly { message: GmailMessageRef }[];
  messagesDeleted?: readonly { message: GmailMessageRef }[];
  labelsAdded?: readonly {
    message: GmailMessageRef;
    labelIds?: readonly string[];
  }[];
  labelsRemoved?: readonly {
    message: GmailMessageRef;
    labelIds?: readonly string[];
  }[];
};

export type GmailProfile = {
  emailAddress?: string;
  historyId: string;
};

export type GmailMessageListPage = {
  messages?: readonly GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

export type GmailHistoryPage = {
  history?: readonly GmailHistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
};

export type GmailAttachmentPayload = {
  data?: string;
  size?: number;
};

export class GmailApiError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(options: { status: number; message: string; reason?: string }) {
    super(options.message);
    this.name = "GmailApiError";
    this.status = options.status;
    this.reason = options.reason;
  }
}

export interface GmailProvider {
  getProfile(): Promise<GmailProfile>;
  listMessages(options: {
    query: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<GmailMessageListPage>;
  getMessage(messageId: string): Promise<GmailMessage>;
  listHistory(options: {
    startHistoryId: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<GmailHistoryPage>;
  getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<GmailAttachmentPayload>;
}

export type GmailCursor = {
  historyId: string | null;
};

export type GmailOrderMailAttachment = {
  sourceKey: string;
  mailboxId: string;
  messageId: string;
  attachmentId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  dataBase64Url?: string;
};

export type GmailOrderMail = {
  sourceKey: string;
  mailboxId: string;
  messageId: string;
  threadId: string | null;
  historyId: string | null;
  internalDate: string | null;
  labelIds: readonly string[];
  headers: Readonly<Record<string, string>>;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
};

export type GmailOrderMailEvent = {
  sourceKey: string;
  mailboxId: string;
  historyId: string;
  messageId: string;
  threadId: string | null;
  kind: GmailHistoryEventKind;
  labelIds: readonly string[];
};

export type GmailNormalizedMessage = {
  mail: GmailOrderMail;
  attachments: readonly GmailOrderMailAttachment[];
};

type GmailSyncMode = "bootstrap" | "incremental" | "full_resync";
export type GmailSyncReason = "first_sync" | "history_expired" | "incremental";

export type GmailBootstrapInput = {
  knownSenders: readonly string[];
  earliestUnresolvedHuntAt?: Date | null;
  now?: Date;
  lookbackDays?: number;
};

export type GmailBootstrapPlan = {
  knownSenderQueries: readonly string[];
  unknownOrderQuery: string;
};

export type GmailSyncResult = {
  mode: GmailSyncMode;
  reason: GmailSyncReason;
  cursor: GmailCursor;
  messages: readonly GmailOrderMail[];
  events: readonly GmailOrderMailEvent[];
  attachments: readonly GmailOrderMailAttachment[];
};
