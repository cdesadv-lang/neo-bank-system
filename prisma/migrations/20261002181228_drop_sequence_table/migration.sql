/*
  Warnings:

  - You are about to drop the `Sequence` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "Sequence";

-- Native sequences (non-blocking, no row locks) for human-readable numbers.
CREATE SEQUENCE IF NOT EXISTS nb_journal_seq START 1000001;
CREATE SEQUENCE IF NOT EXISTS nb_cif_seq START 100001;
CREATE SEQUENCE IF NOT EXISTS nb_account_seq START 1000001;
CREATE SEQUENCE IF NOT EXISTS nb_loan_seq START 50001;
CREATE SEQUENCE IF NOT EXISTS nb_transfer_seq START 1;
CREATE SEQUENCE IF NOT EXISTS nb_ticket_seq START 1001;
CREATE SEQUENCE IF NOT EXISTS nb_alert_seq START 1;
CREATE SEQUENCE IF NOT EXISTS nb_case_seq START 1;
CREATE SEQUENCE IF NOT EXISTS nb_batch_seq START 1;
CREATE SEQUENCE IF NOT EXISTS nb_bill_seq START 1;
CREATE SEQUENCE IF NOT EXISTS nb_card_seq START 1;
