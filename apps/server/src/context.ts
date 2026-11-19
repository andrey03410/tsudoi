import type { PrismaClient } from "./db.js";

export interface AppContext {
  db: PrismaClient;
  storageDir: string;
  secureCookies: boolean;
  now(): Date;
  notify(chatId?: string, additionallyNotifyActorIds?: string[]): void;
}
