-- Irreversible data repair: restoring the previously corrupt product slugs is unsafe.
SELECT 1; -- Repaired ASCII-safe URLs are intentionally preserved during rollback.
