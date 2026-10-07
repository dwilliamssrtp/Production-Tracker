-- SRTP Production Tracker — hardening
-- Run after 05_api_write.sql. Idempotent; safe to re-run after adding any function.
--
-- Both items came from Supabase's own database advisor, which is worth running after any
-- schema change (Dashboard → Advisors).
--
-- 1. Internal helpers must not be reachable from a browser. Supabase exposes every
--    function in `public` at /rest/v1/rpc/<name>, so leaving one out of the grant list is
--    NOT the same as it being unreachable — EXECUTE has to be revoked explicitly. Done by
--    rule over every underscore-prefixed function rather than by list, so the next helper
--    can't be forgotten the way _assert_not_last_admin was.
--
-- 2. Pin search_path. Without it a function resolves unqualified names against whatever
--    search_path the caller happens to have — the mechanism by which a SECURITY DEFINER
--    function gets talked into operating on someone else's table.
--
--    It must be `public, extensions`, NOT `public` alone. Supabase installs pgcrypto into
--    the `extensions` schema, so pinning to public alone hides crypt(), gen_salt(),
--    digest() and gen_random_bytes() from the functions that need them — which broke
--    sign-in completely the first time this ran. Including `extensions` is safe: that
--    schema is owned by supabase_admin and is not user-writable, so nothing can be
--    shadowed inside it.
--
-- What the advisor still reports, by design:
--   * "RLS enabled, no policy" on all 13 tables — intentional. No policies means no direct
--     table access at all; the api_ functions are the only way in.
--   * "anon can execute SECURITY DEFINER function" for the api_ functions — intentional.
--     That IS the API. Each one checks the session token and role before doing anything.

-- 1. Revoke browser access to every internal helper.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.fn);
  end loop;
end $$;

-- 2. Pin search_path on every function in public, helpers and api_ alike.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, '{}')) c
        where c = 'search_path=public, extensions')
  loop
    execute format('alter function %s set search_path = public, extensions', r.fn);
  end loop;
end $$;

-- Verify. Expect: helpers_anon_can_call 0, functions_without_correct_search_path 0,
-- api_functions_callable 37, and crypt_reachable true.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '\_%'
      and has_function_privilege('anon', p.oid, 'execute'))                 as helpers_anon_can_call,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c
                      where c = 'search_path=public, extensions'))          as functions_without_correct_search_path,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'api\_%'
      and has_function_privilege('anon', p.oid, 'execute'))                 as api_functions_callable,
  (select count(*) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'extensions' and p.proname = 'crypt')                 as crypt_reachable;
