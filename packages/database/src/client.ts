import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client.js";

type PrismaGlobal = typeof globalThis & {
  shopmatePrisma?: PrismaClient;
};

const prismaGlobal = globalThis as PrismaGlobal;

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required to create Prisma Client");
  }

  const adapter = new PrismaPg({
    connectionString,
  });

  return new PrismaClient({
    adapter,
  });
}

export function getPrismaClient(): PrismaClient {
  if (!prismaGlobal.shopmatePrisma) {
    prismaGlobal.shopmatePrisma = createPrismaClient();
  }

  return prismaGlobal.shopmatePrisma;
}

export async function disconnectPrismaClient(): Promise<void> {
  if (!prismaGlobal.shopmatePrisma) {
    return;
  }

  await prismaGlobal.shopmatePrisma.$disconnect();
  prismaGlobal.shopmatePrisma = undefined;
}
