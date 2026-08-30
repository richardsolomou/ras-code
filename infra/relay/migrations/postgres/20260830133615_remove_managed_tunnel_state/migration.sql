DELETE FROM "relay_environment_links" WHERE "endpoint_provider_kind" = 'cloudflare_tunnel';--> statement-breakpoint
ALTER TABLE "relay_environment_links" RENAME COLUMN "managed_tunnels_enabled" TO "managed_relay_enabled";--> statement-breakpoint
DROP TABLE "relay_managed_endpoint_allocations";--> statement-breakpoint
DROP TABLE "relay_managed_tunnel_limits";
