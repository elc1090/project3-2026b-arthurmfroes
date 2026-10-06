import type * as Y from 'yjs';

export type BoardId = string;
export type AccountId = string;
export type SessionId = string;
export type AssetId = string;
export type UpdateId = string;
export type DiagnosticEventId = string;

export interface SessionContext {
  sessionId: SessionId;
  accountId: AccountId;
}

export interface BoardMembership {
  boardId: BoardId;
  accountId: AccountId;
  joinedAt: string;
}

export interface AuthorizedBoardSession extends SessionContext {
  boardId: BoardId;
  membership: BoardMembership;
  boardEpoch: number;
}

/** One in-memory document belongs to exactly one stable server-issued board ID. */
export interface BoardDocument {
  boardId: BoardId;
  doc: Y.Doc;
}

/** Opaque Yjs bytes are stored before a durable acknowledgement is sent. */
export interface BoardUpdate {
  updateId: UpdateId;
  boardId: BoardId;
  originAccountId: AccountId;
  bytes: Uint8Array;
  receivedAt: string;
}

export interface DurableUpdateAck {
  boardId: BoardId;
  updateId: UpdateId;
  committedAt: string;
}

/** The board model carries asset identity and placement, never image bytes. */
export interface BoardAssetRef {
  assetId: AssetId;
  mimeType: string;
  width: number;
  height: number;
}

export interface DiagnosticEvent {
  eventId: DiagnosticEventId;
  boardId: BoardId;
  actionId: string;
  replicaId: string;
  kind: 'local-edit' | 'peer-received' | 'server-received' | 'durable-ack';
  firstArrivalPath?: 'local' | 'peer' | 'server';
  updateBytes?: number;
  observedAt: string;
  /** Replica-local sequence; timestamps do not define a global event order. */
  localSequence: number;
}
