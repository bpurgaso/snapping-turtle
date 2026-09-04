-- M9 native desktop client (PLAN.md §5, §7, §8): a capture may have no source
-- page. Browser uploads keep sending sourceUrl; the Linux client sends none and
-- the capture page omits the "Open original page" link when the column is NULL.
ALTER TABLE "captures" ALTER COLUMN "source_url" DROP NOT NULL;
