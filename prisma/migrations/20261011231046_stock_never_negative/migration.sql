-- A database-level safety net: Prisma can't express CHECK constraints natively.
-- Defence-in-depth: code has bugs; constraints don't forget.
ALTER TABLE "products" ADD CONSTRAINT stock_non_negative CHECK (stock >= 0);