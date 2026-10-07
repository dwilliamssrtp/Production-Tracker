-- SRTP Production Tracker — hardening
-- Run after 05_api_write.sql. Idempotent; safe to re-run after adding any function.
--
-- Both of these came from Supabase's own database advisor, which is worth running after
-- any schema change (Dashboard → Advisors, or get_advisors over the MCP connector).
--
-- 1. Internal helpers must not be reachable from a browser. Supabase exposes every
--    function in `public` at /rest/v1/rpc/<name>, so "not in the grant list" isn't the
--    same as "not callable" — EXECUTE has to be revoked explicitly. I revoked most of
--    them by hand when writing 02/04/05 and missed _assert_not_last_admin. Doing it by
--    rule rather than by list means the next helper can't be forgotten the same way.
--
-- 2. Pin search_path on every helper. Without it, a function resolves unqualified names
--    against whatever search_path the caller has — which is the mechanism by which a
--    SECURITY DEFINER function can be talked into operating on someone else's table.
--    The api_ functions already set it; the helpers were written before that was habit.
--
-- What the advisor still reports, by design:
--   * "RLS enabled, no policy" on all 13 tables — intentional. No policies means no
--     direct table access at all; the api_ functions are the only way in.
--   * "anon can execute SECURITY DEFINER function" for the api_ functions — intentional.
--     That IS the API. Each one checks the session token and role before doing anything.

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

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '\_%'
      and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')
  loop
    execute format('alter function %s set search_path = public', r.fn);
  end loop;
end $$;

-- Verify: helpers 0 and 0, api functions 37.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like '\_%'
      and has_function_privilege('anon', p.oid, 'execute'))                        as helpers_anon_can_call,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like '\_%'
      and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')) as helpers_without_search_path,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'api\_%'
      and has_function_privilege('anon', p.oid, 'execute'))                        as api_functions_callable;
