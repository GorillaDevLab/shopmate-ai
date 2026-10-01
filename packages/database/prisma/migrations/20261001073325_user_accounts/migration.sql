-- CreateTable
CREATE TABLE "UserAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMerchantMembership" (
    "userId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMerchantMembership_pkey" PRIMARY KEY ("userId","merchantId")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAccount_email_key"
ON "UserAccount"("email");

-- CreateIndex
CREATE INDEX "UserMerchantMembership_merchantId_idx"
ON "UserMerchantMembership"("merchantId");

-- AddForeignKey
ALTER TABLE "UserMerchantMembership"
ADD CONSTRAINT "UserMerchantMembership_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "UserAccount"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMerchantMembership"
ADD CONSTRAINT "UserMerchantMembership_merchantId_fkey"
FOREIGN KEY ("merchantId")
REFERENCES "Merchant"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
