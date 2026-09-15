CREATE TABLE "Store" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Store_merchantId_id_key" ON "Store"("merchantId", "id");
CREATE INDEX "Store_merchantId_platform_idx" ON "Store"("merchantId", "platform");
ALTER TABLE "Store" ADD CONSTRAINT "Store_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD COLUMN "storeId" TEXT;
CREATE INDEX "Order_merchantId_storeId_orderedAt_idx" ON "Order"("merchantId", "storeId", "orderedAt");
ALTER TABLE "Order" ADD CONSTRAINT "Order_merchantId_storeId_fkey" FOREIGN KEY ("merchantId", "storeId") REFERENCES "Store"("merchantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
