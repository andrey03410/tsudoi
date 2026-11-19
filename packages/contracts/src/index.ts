export type Role = "admin" | "member" | "guest";
export type InviteKind = "account" | "guest";
export type ChatKind = "direct" | "group";

export interface Actor {
  id: string;
  displayName: string;
  role: Role;
  expiresAt: string | null;
}

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  title: string;
  preview: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  isOwner: boolean;
}

export interface ChatDetail extends ChatSummary {
  members: Actor[];
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface Reaction {
  emoji: string;
  count: number;
  guestCount: number;
  mine: boolean;
}

export interface Message {
  id: number;
  clientId: string;
  author: Actor;
  text: string | null;
  stickerId: string | null;
  createdAt: string;
  reactions: Reaction[];
  attachments: Attachment[];
}

export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
  cursor: number;
}

export interface Invite {
  id: string;
  kind: InviteKind;
  expiresAt: string;
  status: "active" | "used" | "revoked" | "expired";
}

export interface IssuedInvite {
  invite: Invite;
  token: string;
}

export interface InvitePreview {
  kind: InviteKind;
  expiresAt: string;
  chatId?: string;
  title?: string;
}

export interface InviteAccepted {
  actor: Actor;
  chatId?: string;
}

export interface ApiFailure {
  error: { code: string; message: string };
}

export interface LiveEvent {
  type: "changed";
  chatId?: string;
}
