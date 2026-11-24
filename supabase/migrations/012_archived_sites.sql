-- Keep retired site identities and revision history while allowing an explicitly
-- retired domain to be admitted again through the ordinary creation workflow.
alter table public.sites add column archived_at timestamptz;
create unique index sites_active_domain on public.sites(domain) where archived_at is null;
alter table public.sites drop constraint sites_domain_key;
