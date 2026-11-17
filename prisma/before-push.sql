-- Runs before "prisma db push" on every start.
-- db push won't add a unique constraint to an existing table without
-- --accept-data-loss (which we never use), so those columns and their unique
-- indexes are made here first, under the names Prisma expects. db push then
-- finds nothing to change. Every statement is safe to run again.

-- Pack Cam (PrintStation): new, empty columns, so no duplicates
ALTER TABLE "PrintStation" ADD COLUMN IF NOT EXISTS "packCamKeyHash" TEXT;
ALTER TABLE "PrintStation" ADD COLUMN IF NOT EXISTS "packCamPairHash" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "PrintStation_packCamKeyHash_key" ON "PrintStation"("packCamKeyHash");
CREATE UNIQUE INDEX IF NOT EXISTS "PrintStation_packCamPairHash_key" ON "PrintStation"("packCamPairHash");
