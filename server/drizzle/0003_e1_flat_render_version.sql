-- E1 adaptive annotation sizing (PLAN.md §9/§10): the flat cache is valid only
-- while flat_rev matches annotations_rev AND flat_render_version matches the
-- shared RENDER_VERSION constant. Existing rows get 0 ("rendered before
-- versioning"), so every pre-E1 flat re-renders lazily on its next view.
ALTER TABLE "captures" ADD COLUMN "flat_render_version" integer DEFAULT 0 NOT NULL;