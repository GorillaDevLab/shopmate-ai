-- CreateTable
CREATE TABLE "UserAssistantWorkspace" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAssistantWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAssistantWorkspace_userId_merchantId_key" ON "UserAssistantWorkspace"("userId", "merchantId");

-- CreateIndex
CREATE INDEX "UserAssistantWorkspace_merchantId_idx" ON "UserAssistantWorkspace"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantMemory_userId_merchantId_content_key" ON "AssistantMemory"("userId", "merchantId", "content");

-- CreateIndex
CREATE INDEX "AssistantMemory_userId_merchantId_createdAt_idx" ON "AssistantMemory"("userId", "merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantMemory_merchantId_idx" ON "AssistantMemory"("merchantId");

-- AddForeignKey
ALTER TABLE "UserAssistantWorkspace" ADD CONSTRAINT "UserAssistantWorkspace_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantMemory" ADD CONSTRAINT "AssistantMemory_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "UserAssistantWorkspace"
ADD CONSTRAINT "UserAssistantWorkspace_revision_positive_check"
CHECK ("revision" > 0);

-- AddCheckConstraint
ALTER TABLE "AssistantMemory"
ADD CONSTRAINT "AssistantMemory_content_length_check"
CHECK (char_length("content") BETWEEN 1 AND 200);
