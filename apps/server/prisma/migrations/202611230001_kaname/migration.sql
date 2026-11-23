ALTER TABLE "Actor" ADD COLUMN "kanameSubject" TEXT;
CREATE UNIQUE INDEX "Actor_kanameSubject_key" ON "Actor"("kanameSubject");
ALTER TABLE "Actor" ADD COLUMN "kanameSuspended" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Session" ADD COLUMN "kanameSession" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "KanameActivity" ("subject" TEXT NOT NULL, "day" TEXT NOT NULL, "lastActiveAt" DATETIME NOT NULL, PRIMARY KEY ("subject", "day"));
