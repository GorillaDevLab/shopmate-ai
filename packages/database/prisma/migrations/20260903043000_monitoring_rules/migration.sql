-- CreateEnum
CREATE TYPE "MonitoringRuleKind" AS ENUM ('SALES_THRESHOLD', 'INVENTORY_THRESHOLD');

-- CreateEnum
CREATE TYPE "MonitoringRuleStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MonitoringFrequency" AS ENUM ('DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "MonitoringSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "MonitoringResourceType" AS ENUM ('MERCHANT', 'SKU');

-- CreateTable
CREATE TABLE "UserMonitoringRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "MonitoringRuleKind" NOT NULL,
    "definition" JSONB NOT NULL,
    "frequency" "MonitoringFrequency" NOT NULL,
    "status" "MonitoringRuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMonitoringRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringNotification" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" "MonitoringSeverity" NOT NULL,
    "resourceType" "MonitoringResourceType" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitoringNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserMonitoringRule_userId_merchantId_status_nextRunAt_idx" ON "UserMonitoringRule"("userId", "merchantId", "status", "nextRunAt");

-- CreateIndex
CREATE INDEX "UserMonitoringRule_merchantId_idx" ON "UserMonitoringRule"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "MonitoringNotification_userId_merchantId_fingerprint_key" ON "MonitoringNotification"("userId", "merchantId", "fingerprint");

-- CreateIndex
CREATE INDEX "MonitoringNotification_userId_merchantId_readAt_createdAt_idx" ON "MonitoringNotification"("userId", "merchantId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "MonitoringNotification_ruleId_idx" ON "MonitoringNotification"("ruleId");

-- CreateIndex
CREATE INDEX "MonitoringNotification_merchantId_idx" ON "MonitoringNotification"("merchantId");

-- AddForeignKey
ALTER TABLE "UserMonitoringRule" ADD CONSTRAINT "UserMonitoringRule_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringNotification" ADD CONSTRAINT "MonitoringNotification_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "UserMonitoringRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringNotification" ADD CONSTRAINT "MonitoringNotification_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
