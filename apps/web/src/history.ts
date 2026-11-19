import type { Message } from "@tsudoi/contracts";

export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const messages = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => a.id - b.id);
}

export type PageChanges = Map<number, { message: Message; cursor: number }>;

export function rememberPageChanges(cache: PageChanges, incoming: Message[], before: number, cursor: number) {
  for (const message of incoming) {
    if (message.id < before) cache.set(message.id, { message, cursor });
  }
  // Only the nearest 40 older messages can appear in the requested history page.
  while (cache.size > 40) cache.delete(Math.min(...cache.keys()));
}

export function prependMessages(current: Message[], older: Message[], changes?: PageChanges, pageCursor = 0): Message[] {
  const page = older.map(message => {
    const change = changes?.get(message.id);
    return change && change.cursor > pageCursor ? change.message : message;
  });
  return mergeMessages(page, current);
}
