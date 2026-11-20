-- The Home Loan product (V1 had personal, vehicle, home and education loans).
INSERT INTO "LoanProduct" ("id","code","name","minAmountMinor","maxAmountMinor","minTermMonths","maxTermMonths","rateBps","active")
SELECT gen_random_uuid(), 'HOME', 'Home Loan', 100000000, 20000000000, 60, 300, 1050, true
WHERE EXISTS (SELECT 1 FROM "LoanProduct") AND NOT EXISTS (SELECT 1 FROM "LoanProduct" WHERE "code" = 'HOME');
