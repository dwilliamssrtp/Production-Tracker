-- SRTP Production Tracker — historical records typed up from the paper logs
-- Run after 09_live_and_chained_progress.sql. Idempotent.
--
-- Reels that ran before the tracker existed. The controller types them in from the paper
-- production log so the old runs sit alongside the new ones in Reports.
--
-- Two rules shape the whole thing:
--
--   1. These rows are marked time_source = 'Historical', never 'Device'. The provenance
--      columns exist so a report can say where a timestamp came from; a transcribed paper
--      time was neither stamped by the app nor typed at the line, and calling it 'Device'
--      would quietly assert something untrue about the record.
--
--   2. They are kept off the live board and the TV. A wall display showing last year's
--      reels next to what is running now is worse than useless.

alter table work_orders add column if not exists historical boolean not null default false;

-- ---------------------------------------------------------------------------
-- 1. The board hides history; Reports asks for it
-- ---------------------------------------------------------------------------
-- api_dashboard gains p_include_historical (default false). The 1-arg version MUST be
-- dropped: leaving both makes every call ambiguous ("function is not unique") and the
-- dashboard stops loading entirely.
--
-- NOTE: the body below is the existing function with ONE line changed, in the join. If you
-- are regenerating this file, copy the live definition rather than rewriting it from
-- memory — the payload keys (pipeCode, blStatus, workOrderCode, activePipes …) are read
-- directly by the front end and are easy to get subtly wrong.

-- See the live definition for the full body; only the join predicate differs:
--
--   join work_orders w on w.code = p.work_order_code and not w.archived
--                     and (coalesce(p_include_historical, false) or not w.historical)
--
-- Applied on the live project 2026-10-12, together with:
--   drop function if exists api_dashboard(text);
--   grant execute on function api_dashboard(text, boolean) to anon, authenticated;

-- Archive carries historical records: they are finished history, which is what the archive
-- is for, and it keeps them reachable without putting them on the board.
-- (api_list_archive: `from work_orders w where w.archived or w.historical`, plus a
--  'historical' flag on each row and ordering by coalesce(archived_at, created_at).)

-- _wo_json gains 'Historical' so the front end can label one wherever it appears.

-- ---------------------------------------------------------------------------
-- 2. The import
-- ---------------------------------------------------------------------------
create or replace function api_import_historical(
  p_token text, p_wo jsonb, p_pipe_code text, p_sections jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  acct      accounts;
  wo_code   text := trim(coalesce(p_wo ->> 'code', ''));
  pc        text := trim(coalesce(p_pipe_code, ''));
  ww        work_orders;
  sec       jsonb;
  rd        jsonb;
  sec_name  text;
  pfx       text;
  n_read    int := 0;
  n_sec     int := 0;
  started   timestamptz;
  finished  timestamptz;
  len       numeric;
  ts        timestamptz;
begin
  acct := _require(p_token, array['Admin']);
  if acct.role <> 'Admin' then raise exception 'Only the controller can enter historical records'; end if;
  if wo_code = '' then raise exception 'Work order code is required'; end if;
  if pc = ''      then raise exception 'Reel code is required'; end if;

  -- One call, one transaction. A reel's worth of paper readings written as dozens of
  -- separate calls would leave a half-imported reel behind the moment anything failed,
  -- and the person typing would have no idea how far it got.
  select * into ww from work_orders where code = wo_code;
  if ww.code is null then
    insert into work_orders (code, created_by, customer, product_code, pipe_size,
                             email_to, project_length, spec, historical)
    values (wo_code, coalesce(acct.name, acct.username),
            coalesce(p_wo ->> 'customer',''), coalesce(p_wo ->> 'productCode',''),
            coalesce(p_wo ->> 'pipeSize',''), '',
            nullif(p_wo ->> 'projectLength','')::numeric,
            coalesce(p_wo -> 'spec', '{}'::jsonb), true)
    returning * into ww;
  elsif not ww.historical then
    -- Typing history into a live job would mix reconstructed rows into a running record.
    raise exception 'Work order % already exists as a live job. Use a different code for historical records.', wo_code;
  end if;

  if exists (select 1 from pipes where pipe_code = pc) then
    raise exception 'Reel % already exists', pc;
  end if;
  insert into pipes (pipe_code, work_order_code, created_by)
  values (pc, wo_code, coalesce(acct.name, acct.username));

  for sec in select * from jsonb_array_elements(coalesce(p_sections, '[]'::jsonb)) loop
    sec_name := sec ->> 'section';
    pfx := _prefix(sec_name);
    if pfx is null then raise exception 'Unknown section: %', sec_name; end if;
    n_sec := n_sec + 1;

    started  := nullif(sec ->> 'startedAt','')::timestamptz;
    finished := nullif(sec ->> 'completedAt','')::timestamptz;
    len      := nullif(sec ->> 'actualLength','')::numeric;

    for rd in select * from jsonb_array_elements(coalesce(sec -> 'readings', '[]'::jsonb)) loop
      ts := coalesce(nullif(rd ->> 'ts','')::timestamptz, finished, started, now());

      if nullif(rd ->> 'od','') is not null then
        insert into readings (pipe_code, section, ts, operator, type, value, in_tol, footage,
                              entered_at, time_source, time_offset_min)
        values (pc, sec_name, ts, coalesce(sec ->> 'operator',''), 'OD',
                (rd ->> 'od')::numeric,
                _compute_in_tol(ww, sec_name, 'OD', (rd ->> 'od')::numeric),
                nullif(rd ->> 'footage','')::numeric,
                now(), 'Historical', 0);
        n_read := n_read + 1;
      end if;

      -- Pitch is braidline only, recorded against the same moment as its OD so the two
      -- line up on the charts.
      if sec_name = 'Braidline' and nullif(rd ->> 'pitch','') is not null then
        insert into readings (pipe_code, section, ts, operator, type, value, in_tol, footage,
                              entered_at, time_source, time_offset_min)
        values (pc, sec_name, ts, coalesce(sec ->> 'operator',''), 'Pitch',
                (rd ->> 'pitch')::numeric,
                _compute_in_tol(ww, sec_name, 'Pitch', (rd ->> 'pitch')::numeric),
                nullif(rd ->> 'footage','')::numeric,
                now(), 'Historical', 0);
        n_read := n_read + 1;
      end if;
    end loop;

    -- A historical section is finished by definition; its dates come off the paper rather
    -- than from a clock that was never running.
    execute format(
      'update pipes set %I = ''Complete'', %I = $1, %I = $2, %I = $3 where pipe_code = $4',
      pfx||'_status', pfx||'_started_at', pfx||'_completed_at', pfx||'_actual_length')
      using started, coalesce(finished, started), len, pc;
  end loop;

  update pipes set overall_status =
    case when bl_status='Complete' and br_status='Complete' and cv_status='Complete'
         then 'Complete' else 'Active' end
   where pipe_code = pc;

  perform _recompute_reel_summary(pc);
  perform _touch_pipe(pc);

  return jsonb_build_object('workOrderCode', wo_code, 'pipeCode', pc,
                            'sections', n_sec, 'readings', n_read);
end;
$$;

-- Deliberately bypasses api_add_readings: that function forces any timestamp more than
-- five minutes off the clock to 'Manual' and flags it as back-dated, which is correct for
-- live logging and wrong here, where every row is a year old by design.

grant execute on function api_import_historical(text, jsonb, text, jsonb) to anon, authenticated;

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

-- Expect both 0, and exactly one api_dashboard signature.
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
