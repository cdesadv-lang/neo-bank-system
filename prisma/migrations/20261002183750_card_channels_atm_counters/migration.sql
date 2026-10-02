-- AlterEnum
ALTER TYPE "TillKind" ADD VALUE 'ATM';

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "atmDailyLimit" BIGINT NOT NULL DEFAULT 2000000,
ADD COLUMN     "atmEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "contactlessEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "contactlessNoPinLimit" BIGINT NOT NULL DEFAULT 60000,
ADD COLUMN     "ecomDailyLimit" BIGINT NOT NULL DEFAULT 2500000,
ADD COLUMN     "internationalEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinTries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pinVerificationValue" TEXT,
ADD COLUMN     "posDailyLimit" BIGINT NOT NULL DEFAULT 5000000,
ADD COLUMN     "posEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CardAuthorization" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "rrn" TEXT NOT NULL,
    "stan" TEXT NOT NULL,
    "authCode" TEXT,
    "cardId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "txnType" TEXT NOT NULL,
    "acquirer" TEXT NOT NULL DEFAULT 'OWN',
    "amount" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "feeAmount" BIGINT NOT NULL DEFAULT 0,
    "merchantName" TEXT,
    "merchantId" TEXT,
    "mcc" TEXT,
    "merchantCountry" TEXT,
    "terminalId" TEXT,
    "entryMode" TEXT,
    "status" TEXT NOT NULL,
    "responseCode" TEXT NOT NULL,
    "declineReason" TEXT,
    "capturedAmount" BIGINT NOT NULL DEFAULT 0,
    "refundedAmount" BIGINT NOT NULL DEFAULT 0,
    "holdEntryId" TEXT,
    "captureEntryId" TEXT,
    "releaseEntryId" TEXT,
    "reversalEntryId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "threeDsChallengeId" TEXT,
    "dispensed" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardAuthEvent" (
    "id" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "journalEntryId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardAuthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardDispute" (
    "id" TEXT NOT NULL,
    "disputeNo" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "provisionalEntryId" TEXT,
    "resolutionEntryId" TEXT,
    "openedBy" TEXT NOT NULL,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AtmTerminal" (
    "id" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "locationAr" TEXT NOT NULL,
    "locationEn" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'SIMULATED',
    "status" TEXT NOT NULL DEFAULT 'ONLINE',
    "tillId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'EGP',
    "maxWithdrawal" BIGINT NOT NULL DEFAULT 1000000,
    "lastReplenishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AtmTerminal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AtmCassette" (
    "id" TEXT NOT NULL,
    "atmId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "denomination" BIGINT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "currency" "Currency" NOT NULL DEFAULT 'EGP',

    CONSTRAINT "AtmCassette_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AtmReconciliation" (
    "id" TEXT NOT NULL,
    "atmId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "systemBalance" BIGINT NOT NULL,
    "cassetteBalance" BIGINT NOT NULL,
    "countedBalance" BIGINT,
    "variance" BIGINT NOT NULL DEFAULT 0,
    "countSessionId" TEXT,
    "staffId" TEXT,
    "varianceEntryId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AtmReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashCounterDevice" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "driver" TEXT NOT NULL DEFAULT 'SIMULATOR',
    "address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ONLINE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashCounterDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashCountSession" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "tillId" TEXT,
    "currency" "Currency" NOT NULL,
    "purpose" TEXT NOT NULL,
    "denominations" JSONB NOT NULL,
    "total" BIGINT NOT NULL,
    "noteCount" INTEGER NOT NULL,
    "suspectedCounterfeits" INTEGER NOT NULL DEFAULT 0,
    "serials" JSONB,
    "usedRef" TEXT,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashCountSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CardAuthorization_idempotencyKey_key" ON "CardAuthorization"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CardAuthorization_rrn_key" ON "CardAuthorization"("rrn");

-- CreateIndex
CREATE INDEX "CardAuthorization_cardId_createdAt_idx" ON "CardAuthorization"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "CardAuthorization_status_expiresAt_idx" ON "CardAuthorization"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "CardAuthorization_terminalId_idx" ON "CardAuthorization"("terminalId");

-- CreateIndex
CREATE UNIQUE INDEX "CardDispute_disputeNo_key" ON "CardDispute"("disputeNo");

-- CreateIndex
CREATE UNIQUE INDEX "AtmTerminal_terminalId_key" ON "AtmTerminal"("terminalId");

-- CreateIndex
CREATE UNIQUE INDEX "AtmTerminal_tillId_key" ON "AtmTerminal"("tillId");

-- CreateIndex
CREATE UNIQUE INDEX "AtmCassette_atmId_position_key" ON "AtmCassette"("atmId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CashCounterDevice_deviceId_key" ON "CashCounterDevice"("deviceId");

-- AddForeignKey
ALTER TABLE "CardAuthorization" ADD CONSTRAINT "CardAuthorization_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardAuthEvent" ADD CONSTRAINT "CardAuthEvent_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "CardAuthorization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardDispute" ADD CONSTRAINT "CardDispute_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "CardAuthorization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AtmTerminal" ADD CONSTRAINT "AtmTerminal_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AtmCassette" ADD CONSTRAINT "AtmCassette_atmId_fkey" FOREIGN KEY ("atmId") REFERENCES "AtmTerminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AtmReconciliation" ADD CONSTRAINT "AtmReconciliation_atmId_fkey" FOREIGN KEY ("atmId") REFERENCES "AtmTerminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCountSession" ADD CONSTRAINT "CashCountSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CashCounterDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE SEQUENCE IF NOT EXISTS nb_auth_seq START 100001;
CREATE SEQUENCE IF NOT EXISTS nb_dispute_seq START 1;
ALTER TABLE "AtmCassette" ADD CONSTRAINT "AtmCassette_count_nonneg_chk" CHECK (count >= 0);
