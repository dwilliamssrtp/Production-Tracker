-- SRTP Production Tracker — archive and delete individual reels
-- Run after 10_historical_entry.sql. Idempotent.
--
-- Work orders could already be archived and deleted; reels could not. A job usually has
-- one scrapped or mistyped reel long before the work order itself is finished, and the
-- only way to deal with it was to reset it (which empties it but leaves it on the board)
-- or delete the entire work order.

alter table pipes add column if not exists archived     boolean not null default false;
alter table pipes add column if not exists archived_at  timestamptz;
alter table pipes add column if not exists archived_by  text not null default '';

-- ---------------------------------------------------------------------------
-- Archive / restore
-- ---------------------------------------------------------------------------
create or replace function api_archive_pipe(p_token text, p_pipe_code text)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare acct accounts; pc text := trim(coalesce(p_pipe_code,''));
begin
  acct := _require(p_token, array['Admin']);
  if not exists (select 1 from pipes where pipe_code = pc) then
    raise exception 'Reel not found: %', pc;
  end if;
  update pipes set archived = true, archived_at = now(),
                   archived_by = coalesce(acct.name, acct.username), last_updated = now()
   where pipe_code = pc;
  return jsonb_build_object('pipeCode', pc, 'archived', true);
end;
$$;

create or replace function api_unarchive_pipe(p_token text, p_pipe_code text)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare pc text := trim(coalesce(p_pipe_code,''));
begin
  perform _require(p_token, array['Admin']);
  if not exists (select 1 from pipes where pipe_code = pc) then
    raise exception 'Reel not found: %', pc;
  end if;
  update pipes set archived = false, archived_at = null, archived_by = '', last_updated = now()
   where pipe_code = pc;
  return jsonb_build_object('pipeCode', pc, 'archived', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Delete
-- ---------------------------------------------------------------------------
-- What a delete would destroy, so the confirmation can state it instead of asking blind.
create or replace function api_pipe_delete_preview(p_token text, p_pipe_code text)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions
as $$
declare pc text := trim(coalesce(p_pipe_code,'')); pp pipes;
begin
  perform _require(p_token, array['Admin']);
  select * into pp from pipes where pipe_code = pc;
  if pp.pipe_code is null then raise exception 'Reel not found: %', pc; end if;
  return jsonb_build_object(
    'pipeCode', pc, 'archived', to_jsonb(pp.archived),
    'workOrderCode', pp.work_order_code,
    'readings',        (select count(*) from readings         where pipe_code = pc),
    'thicknessChecks', (select count(*) from thickness_checks where pipe_code = pc),
    'materialUsage',   (select count(*) from material_usage   where pipe_code = pc),
    'extruderRuns',    (select count(*) from extruder_runs    where pipe_code = pc),
    'notes',           (select count(*) from notes            where pipe_code = pc),
    'problemReports',  (select count(*) from problem_reports  where pipe_code = pc),
    'photos',          (select count(*) from photos           where pipe_code = pc));
end;
$$;

create or replace function api_delete_pipe(p_token text, p_pipe_code text, p_confirm_code text)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare pc text := trim(coalesce(p_pipe_code,'')); pp pipes; n_read int; n_photo int;
begin
  perform _require(p_token, array['Admin']);
  select * into pp from pipes where pipe_code = pc;
  if pp.pipe_code is null then raise exception 'Reel not found: %', pc; end if;

  -- Archive first, delete second — enforced here and not only on the screen, so the
  -- reversible stage cannot be skipped by calling the API directly. Same rule as
  -- api_delete_work_order.
  if not pp.archived then raise exception 'Archive this reel before deleting it'; end if;
  if trim(coalesce(p_confirm_code,'')) <> pp.pipe_code then
    raise exception 'Type the reel code exactly to confirm';
  end if;

  select count(*) into n_read  from readings where pipe_code = pc;
  select count(*) into n_photo from photos   where pipe_code = pc;

  -- Every history table cascades from pipes, so nothing is left orphaned in the database.
  -- Photo FILES in Storage are the exception: they can't be removed from SQL, so the count
  -- is returned and the confirmation says they stay behind.
  delete from pipes where pipe_code = pc;

  return jsonb_build_object('pipeCode', pc, 'deleted',
    jsonb_build_object('readings', n_read, 'photos', n_photo));
end;
$$;

-- ---------------------------------------------------------------------------
-- The board hides archived reels; Reports still lists them
-- ---------------------------------------------------------------------------
-- Patched into the live api_dashboard rather than rewritten, because its payload keys are
-- read directly by the front end. Two changes:
--
--   join ... and not w.archived
--     becomes
--   join ... and not w.archived and (coalesce(p_include_historical, false) or not p.archived)
--
--   and each pipe's JSON gains  'archived', to_jsonb(pr.archived)
--   (with p.archived / pr.archived carried through the pipe_rows and built CTEs).
--
-- The flag Reports already passes now means "show me what has been put away" and covers
-- both archived reels and historical work orders.
--
-- NOTE for anyone re-applying this by text substitution: the stored function body uses
-- \r\n, so a multi-line search string silently matches nothing. Anchor on a short
-- single-line fragment and assert the match count before executing.

grant execute on function api_archive_pipe(text,text)         to anon, authenticated;
grant execute on function api_unarchive_pipe(text,text)       to anon, authenticated;
grant execute on function api_pipe_delete_preview(text,text)  to anon, authenticated;
grant execute on function api_delete_pipe(text,text,text)     to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Re-harden. REQUIRED — see 06_harden.sql.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c
                      where c = 'search_path=public, extensions')
  loop
    execute format('alter function %s set search_path = public, extensions', r.fn);
  end loop;

  for r in
    select p.oid::regprocedure as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.fn);
  end loop;
end $$;

-- Expect 0, 0, and exactly 1 api_dashboard signature.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c
                      where c='search_path=public, extensions'))   as wrong_search_path,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like '\_%'
      and has_function_privilege('anon', p.oid,'execute'))         as helpers_anon_can_call,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='api_dashboard')        as dashboard_signatures;
