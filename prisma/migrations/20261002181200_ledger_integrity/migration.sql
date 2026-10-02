-- Ledger integrity guarantees enforced by the database itself.

-- 1) Each journal line is either a debit or a credit, never negative, never both.
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_one_side_chk"
  CHECK ((debit >= 0 AND credit >= 0) AND ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)));

-- 2) Sub-ledger balances can never be negative (no overdraft product exists).
ALTER TABLE "Account" ADD CONSTRAINT "Account_balance_nonneg_chk" CHECK (balance >= 0);
ALTER TABLE "Till" ADD CONSTRAINT "Till_balance_nonneg_chk" CHECK (balance >= 0);
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_outstanding_nonneg_chk" CHECK ("outstandingPrincipal" >= 0);

-- 3) Posted journal lines are immutable.
CREATE OR REPLACE FUNCTION nb_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JournalLine_immutable" BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION nb_forbid_change();

CREATE TRIGGER "AuditLog_immutable" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION nb_forbid_change();

-- 4) Journal entries cannot be deleted; the only permitted update is POSTED -> REVERSED.
CREATE OR REPLACE FUNCTION nb_journal_entry_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: DELETE on JournalEntry is not allowed';
  END IF;
  IF NEW."entryNo" <> OLD."entryNo" OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW.type <> OLD.type OR NEW.currency <> OLD.currency OR NEW."valueDate" <> OLD."valueDate"
     OR NEW."postedAt" <> OLD."postedAt" OR NEW.description <> OLD.description
     OR NEW."reversalOfId" IS DISTINCT FROM OLD."reversalOfId" THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: posted JournalEntry fields cannot change';
  END IF;
  IF NOT (OLD.status = 'POSTED' AND NEW.status IN ('POSTED', 'REVERSED')) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: invalid JournalEntry status transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JournalEntry_guard" BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION nb_journal_entry_guard();

-- 5) Every journal entry must balance (sum debits = sum credits) at COMMIT time.
CREATE OR REPLACE FUNCTION nb_check_entry_balanced() RETURNS trigger AS $$
DECLARE d NUMERIC; c NUMERIC;
BEGIN
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO d, c
    FROM "JournalLine" WHERE "entryId" = NEW."entryId";
  IF d <> c THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL: entry % debits % credits %', NEW."entryId", d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "JournalLine_balanced" AFTER INSERT ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nb_check_entry_balanced();
