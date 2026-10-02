-- CreateTable
CREATE TABLE "UserAnalyticsLayout" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "layout" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAnalyticsLayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAnalyticsLayout_merchantId_idx" ON "UserAnalyticsLayout"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "UserAnalyticsLayout_userId_merchantId_key" ON "UserAnalyticsLayout"("userId", "merchantId");

-- AddForeignKey
ALTER TABLE "UserAnalyticsLayout" ADD CONSTRAINT "UserAnalyticsLayout_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "UserAnalyticsLayout"
ADD CONSTRAINT "UserAnalyticsLayout_revision_positive_check"
CHECK ("revision" > 0);

-- AddCheckConstraint
ALTER TABLE "UserAnalyticsLayout"
ADD CONSTRAINT "UserAnalyticsLayout_schemaVersion_positive_check"
CHECK ("schemaVersion" > 0);
