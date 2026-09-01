-- CreateTable
CREATE TABLE "UserDashboardLayout" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "layout" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDashboardLayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserDashboardLayout_merchantId_idx" ON "UserDashboardLayout"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "UserDashboardLayout_userId_merchantId_key" ON "UserDashboardLayout"("userId", "merchantId");

-- AddForeignKey
ALTER TABLE "UserDashboardLayout" ADD CONSTRAINT "UserDashboardLayout_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "UserDashboardLayout"
ADD CONSTRAINT "UserDashboardLayout_revision_positive_check"
CHECK ("revision" > 0);

-- AddCheckConstraint
ALTER TABLE "UserDashboardLayout"
ADD CONSTRAINT "UserDashboardLayout_schemaVersion_positive_check"
CHECK ("schemaVersion" > 0);
