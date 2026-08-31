CREATE TYPE "public"."account_link_purpose" AS ENUM('setup', 'reset');--> statement-breakpoint
CREATE TABLE "account_links" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"purpose" "account_link_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" integer NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" integer,
	"detail" jsonb NOT NULL,
	"ip" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ip_bans" (
	"ip_prefix" text PRIMARY KEY NOT NULL,
	"strikes" integer NOT NULL,
	"banned_until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_links_user_id_idx" ON "account_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ip_bans_banned_until_idx" ON "ip_bans" USING btree ("banned_until");--> statement-breakpoint
-- CLAUDE.md rule 7: append-only is enforced by the database, not convention.
-- The server connects at runtime as `st_app`, which can INSERT and SELECT on
-- audit_log but can never UPDATE or DELETE it. Migrations (this file) run as
-- a more privileged role — the table owner — via MIGRATE_DATABASE_URL in
-- production; st_app's password is synced from DATABASE_URL at boot
-- (start.ts) because CREATE ROLE in a static migration cannot carry one.
DO $$ BEGIN
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'st_app') THEN
		CREATE ROLE "st_app" LOGIN;
	END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA "public" TO "st_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "users", "settings", "sessions", "api_tokens", "captures", "ip_bans", "account_links" TO "st_app";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "audit_log" TO "st_app";--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "st_app";
