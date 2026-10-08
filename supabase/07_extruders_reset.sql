-- SRTP Production Tracker — extruder run logging, and admin reset
-- Run after 06_harden.sql. Idempotent; re-run 06_harden.sql afterwards (it pins
-- search_path on functions added here).
--
-- Three things:
--   1. extruder_runs — what the extruders were ACTUALLY doing, against what the recipe
--      card said they should be. The recipe lives in work_orders.spec and never changes;
--      this is the measured counterpart, logged through the run.
--   2. Voiding everything in a section now genuinely un-starts it, so a demo or a
--      mis-scanned reel can be put back rather than showing a timer that has been
--      running since the reading that no longer exists.
--   3. api_reset_section / api_reset_pipe — the controller's clean slate.

-- ---------------------------------------------------------------------------
-- 1. Extruder runs
-- ---------------------------------------------------------------------------
-- Baseline runs three extruders (backer 3.5", bonding 1.25", inner liner 2"); Coverline
-- runs one. Rather than three tables or a section-shaped schema, one row holds whichever
-- of them applies and the unused columns stay null — the UI decides which to ask for.
-- Braidline has no extruder and is simply never offered the card.
create table if not exists extruder_runs (
  id          uuid primary key default gen_random_uuid(),
  pipe_code   text not null references pipes(pipe_code) on delete cascade,
  section     text not null default '',
  ts          timestamptz not null default now(),
  entered_at  timestamptz not null default now(),
  operator    text not null default '',

  backer_rpm  numeric,   -- Baseline backer / Coverline main extruder
  bond_rpm    numeric,   -- Baseline only
  liner_rpm   numeric,   -- Baseline only
  line_speed  numeric,   -- actual ft/min at the time of the observation
  melt_temp   numeric,   -- degF, optional
  notes       text not null default '',

  -- Same strike-out rules as every other measurement: an operator requests, the
  -- controller agrees. A fat-fingered RPM is exactly the sort of thing that needs this.
  void_status       text not null default '',
  void_reason       text not null default '',
  void_requested_by text not null default '',
  void_requested_at timestamptz,
  voided_by         text not null default '',
  voided_at         timestamptz
);
create index if not exists extruder_pipe_idx on extruder_runs (pipe_code);
alter table extruder_runs enable row level security;   -- no policies: api_ functions only

create or replace function _extruder_json(e extruder_runs)
returns jsonb language sql stable as $$
  select jsonb_build_object('RowId', e.id, 'PipeCode', e.pipe_code, 'Section', _js(e.section),
    'Timestamp', _jt(e.ts), 'Operator', _js(e.operator),
    'BackerRPM', _jn(e.backer_rpm), 'BondRPM', _jn(e.bond_rpm), 'LinerRPM', _jn(e.liner_rpm),
    'LineSpeed', _jn(e.line_speed), 'MeltTemp', _jn(e.melt_temp), 'Notes', _js(e.notes),
    'VoidStatus', _js(e.void_status), 'VoidReason', _js(e.void_reason),
    'VoidRequestedBy', _js(e.void_requested_by), 'VoidedBy', _js(e.voided_by))
$$;

create or replace function api_add_extruder_run(
  p_token text, p_pipe_code text, p_section text, p_operator text, p_timestamp timestamptz,
  p_backer_rpm numeric, p_bond_rpm numeric, p_liner_rpm numeric,
  p_line_speed numeric, p_melt_temp numeric, p_notes text)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare pc text := trim(coalesce(p_pipe_code,'')); e extruder_runs;
begin
  perform _require(p_token, array['Admin','Operator']);
  if p_backer_rpm is null and p_bond_rpm is null and p_liner_rpm is null
     and p_line_speed is null and p_melt_temp is null then
    raise exception 'Enter at least one value';
  end if;

  insert into extruder_runs (pipe_code, section, ts, operator, backer_rpm, bond_rpm,
                             liner_rpm, line_speed, melt_temp, notes)
  values (pc, coalesce(p_section,''), coalesce(p_timestamp, now()), coalesce(p_operator,''),
          p_backer_rpm, p_bond_rpm, p_liner_rpm, p_line_speed, p_melt_temp, coalesce(p_notes,''))
  returning * into e;

  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, _extruder_json(e));
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Voiding everything in a section un-starts it
-- ---------------------------------------------------------------------------
-- The footage bar already recovered, because it is recomputed from surviving readings.
-- The timer did not: the section was flipped to 'In progress' with a started_at when the
-- first reading landed, and nothing ever put that back. So a reel whose only two readings
-- had been struck out still showed a clock that had been running for hours against
-- measurements that no longer existed.
--
-- Deliberately narrow: only a section that is 'In progress' AND has no surviving readings
-- is reset. A section the controller set in progress on purpose, or one already Complete,
-- is left exactly as it is.
create or replace function _recompute_reel_summary(p_pipe_code text)
returns void
language plpgsql
volatile
as $$
declare
  r readings;
  sec text;
  pfx text;
  live int;
begin
  update pipes set
    last_reading_at = null, last_reading_type = null,
    last_reading_value = null, last_reading_in_tol = null,
    bl_last_footage = null, br_last_footage = null, cv_last_footage = null
  where pipe_code = p_pipe_code;

  -- Entry order, last one wins — the same rule the live write path produces. Ordering by
  -- the claimed timestamp instead would disagree with it, since an operator can back-date.
  select * into r from readings
   where pipe_code = p_pipe_code and void_status <> 'Void'
   order by entered_at desc, id desc limit 1;

  if r.id is not null then
    update pipes set last_reading_at = r.ts, last_reading_type = r.type,
                     last_reading_value = r.value, last_reading_in_tol = r.in_tol
     where pipe_code = p_pipe_code;
  end if;

  update pipes p set
    bl_last_footage = (select rr.footage from readings rr where rr.pipe_code = p_pipe_code
                        and rr.section = 'Baseline'  and rr.type = 'OD' and rr.footage is not null
                        and rr.void_status <> 'Void' order by rr.entered_at desc limit 1),
    br_last_footage = (select rr.footage from readings rr where rr.pipe_code = p_pipe_code
                        and rr.section = 'Braidline' and rr.type = 'OD' and rr.footage is not null
                        and rr.void_status <> 'Void' order by rr.entered_at desc limit 1),
    cv_last_footage = (select rr.footage from readings rr where rr.pipe_code = p_pipe_code
                        and rr.section = 'Coverline' and rr.type = 'OD' and rr.footage is not null
                        and rr.void_status <> 'Void' order by rr.entered_at desc limit 1)
  where p.pipe_code = p_pipe_code;

  foreach sec in array array['Baseline','Braidline','Coverline'] loop
    pfx := _prefix(sec);
    select count(*) into live from readings
     where pipe_code = p_pipe_code and section = sec and void_status <> 'Void';
    if live = 0 then
      execute format(
        'update pipes set %I = case when %I = ''In progress'' then ''Not started'' else %I end,
                          %I = case when %I = ''In progress'' then null else %I end
           where pipe_code = $1',
        pfx||'_status', pfx||'_status', pfx||'_status',
        pfx||'_started_at', pfx||'_status', pfx||'_started_at')
        using p_pipe_code;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Void support for extruder runs
-- ---------------------------------------------------------------------------
create or replace function api_request_void(
  p_token text, p_kind text, p_row_id uuid, p_reason text, p_operator text)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  acct      accounts;
  reason    text := trim(coalesce(p_reason, ''));
  is_admin  boolean;
  pc        text;
  cur       text;
  new_state text;
  who       text;
begin
  acct := _require(p_token, array['Admin','Operator']);
  if reason = '' then raise exception 'Give a reason for voiding this'; end if;
  if p_kind not in ('reading','thickness','extruder') then
    raise exception 'Unknown record type: %', p_kind;
  end if;

  is_admin  := acct.role = 'Admin';
  who       := coalesce(nullif(trim(coalesce(p_operator,'')), ''), acct.name, acct.username);
  -- The controller is the approver, so there is nobody left to ask.
  new_state := case when is_admin then 'Void' else 'Requested' end;

  if p_kind = 'reading' then
    select r.pipe_code, r.void_status into pc, cur from readings r where r.id = p_row_id;
    if pc is null then raise exception 'Record not found'; end if;
    if cur = 'Void' then raise exception 'That record is already voided'; end if;
    update readings set void_status = new_state, void_reason = reason,
           void_requested_by = who, void_requested_at = now(),
           voided_by = case when is_admin then who else voided_by end,
           voided_at = case when is_admin then now() else voided_at end
     where id = p_row_id;
  elsif p_kind = 'thickness' then
    select c.pipe_code, c.void_status into pc, cur from thickness_checks c where c.id = p_row_id;
    if pc is null then raise exception 'Record not found'; end if;
    if cur = 'Void' then raise exception 'That record is already voided'; end if;
    update thickness_checks set void_status = new_state, void_reason = reason,
           void_requested_by = who, void_requested_at = now(),
           voided_by = case when is_admin then who else voided_by end,
           voided_at = case when is_admin then now() else voided_at end
     where id = p_row_id;
  else
    select e.pipe_code, e.void_status into pc, cur from extruder_runs e where e.id = p_row_id;
    if pc is null then raise exception 'Record not found'; end if;
    if cur = 'Void' then raise exception 'That record is already voided'; end if;
    update extruder_runs set void_status = new_state, void_reason = reason,
           void_requested_by = who, void_requested_at = now(),
           voided_by = case when is_admin then who else voided_by end,
           voided_at = case when is_admin then now() else voided_at end
     where id = p_row_id;
  end if;

  perform _recompute_reel_summary(pc);
  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, jsonb_build_object('rowId', p_row_id, 'status', new_state));
end;
$$;

create or replace function api_resolve_void(p_token text, p_kind text, p_row_id uuid, p_approve boolean)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  acct      accounts;
  pc        text;
  cur       text;
  new_state text;
  who       text;
begin
  -- Checked here as well as in the role map on purpose: the entire point of the request
  -- step is that an operator cannot strike out their own measurement, and that shouldn't
  -- rest on one layer remembering to say so.
  acct := _require(p_token, array['Admin']);
  if acct.role <> 'Admin' then raise exception 'Only the controller can approve a void'; end if;

  who       := coalesce(acct.name, acct.username);
  new_state := case when p_approve then 'Void' else 'Rejected' end;

  if p_kind = 'reading' then
    select r.pipe_code, r.void_status into pc, cur from readings r where r.id = p_row_id;
    if pc is null then raise exception 'Record not found'; end if;
    if cur <> 'Requested' then raise exception 'There is no pending void request on that record'; end if;
    update readings set void_status = new_state, voided_by = who, voided_at = now() where id = p_row_id;
  elsif p_kind = 'thickness' then
    select c.pipe_code, c.void_status into pc, cur from thickness_checks c where c.id = p_row_id;
    if pc is null then raise exception 'Record not found'; end if;
    if cur <> 'Requested' then raise exception 'There is no pending void request on that record'; end if;
    update thickness_checks set void_status = new_state, voided_by = who, voided_at = now() where id = p_row_id;
  elsif p_kind = 'extruder' then
    select e.pipe_code, e.void_status into pc, cur from extruder_runs e where e.id = p_row_id;
    if pc is null then raise exception 'Record not found'; end if;
    if cur <> 'Requested' then raise exception 'There is no pending void request on that record'; end if;
    update extruder_runs set void_status = new_state, voided_by = who, voided_at = now() where id = p_row_id;
  else
    raise exception 'Unknown record type: %', p_kind;
  end if;

  perform _recompute_reel_summary(pc);
  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, jsonb_build_object('rowId', p_row_id, 'status', new_state));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reset
-- ---------------------------------------------------------------------------
-- Controller only, and the reel code has to be retyped — the same shape as permanently
-- deleting a work order, because this is the same kind of irreversible.
--
-- This genuinely deletes rather than voiding. Voiding is the right tool for a measurement
-- that was taken and was wrong; reset is for a reel that was never really run — a demo, a
-- training session, a reel someone logged against by mistake. Keeping hundreds of struck-
-- out demo rows in the permanent record would make the void list useless for its real job.
--
-- Photos are deliberately NOT touched. Their files live in Storage, which cannot be
-- deleted from SQL, so removing the rows here would orphan the images with nothing left
-- pointing at them. Clear those from Storage -> reel-photos if a reel is being reused.

create or replace function _reset_section_rows(p_pipe_code text, p_section text)
returns jsonb
language plpgsql volatile
as $$
declare
  pfx  text := _prefix(p_section);
  n_rd int; n_tc int; n_mu int; n_dt int; n_ex int;
begin
  if pfx is null then raise exception 'Unknown section: %', p_section; end if;

  with d as (delete from readings         where pipe_code = p_pipe_code and section = p_section returning 1)
    select count(*) into n_rd from d;
  with d as (delete from thickness_checks where pipe_code = p_pipe_code and section = p_section returning 1)
    select count(*) into n_tc from d;
  with d as (delete from material_usage   where pipe_code = p_pipe_code and section = p_section returning 1)
    select count(*) into n_mu from d;
  with d as (delete from downtime_events  where pipe_code = p_pipe_code and section = p_section returning 1)
    select count(*) into n_dt from d;
  with d as (delete from extruder_runs    where pipe_code = p_pipe_code and section = p_section returning 1)
    select count(*) into n_ex from d;

  -- Back to untouched: no status, no clock, no recorded length.
  execute format(
    'update pipes set %I = ''Not started'', %I = null, %I = null, %I = null where pipe_code = $1',
    pfx||'_status', pfx||'_started_at', pfx||'_completed_at', pfx||'_actual_length')
    using p_pipe_code;

  return jsonb_build_object('section', p_section, 'readings', n_rd, 'thicknessChecks', n_tc,
    'materialUsage', n_mu, 'downtimeEvents', n_dt, 'extruderRuns', n_ex);
end;
$$;

create or replace function api_reset_section(
  p_token text, p_pipe_code text, p_section text, p_confirm text)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  pc   text := trim(coalesce(p_pipe_code,''));
  acct accounts;
  res  jsonb;
begin
  acct := _require(p_token, array['Admin']);
  if acct.role <> 'Admin' then raise exception 'Only the controller can reset a reel'; end if;
  if trim(coalesce(p_confirm,'')) <> pc then
    raise exception 'Type the reel code exactly to confirm';
  end if;
  if not exists (select 1 from pipes where pipe_code = pc) then
    raise exception 'Reel not found: %', pc;
  end if;

  res := _reset_section_rows(pc, p_section);

  update pipes set overall_status = 'Active' where pipe_code = pc;
  perform _recompute_reel_summary(pc);
  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, res);
end;
$$;

create or replace function api_reset_pipe(
  p_token text, p_pipe_code text, p_confirm text, p_include_log boolean)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  pc    text := trim(coalesce(p_pipe_code,''));
  acct  accounts;
  parts jsonb := '[]'::jsonb;
  sec   text;
  n_no  int := 0;
  n_pr  int := 0;
begin
  acct := _require(p_token, array['Admin']);
  if acct.role <> 'Admin' then raise exception 'Only the controller can reset a reel'; end if;
  if trim(coalesce(p_confirm,'')) <> pc then
    raise exception 'Type the reel code exactly to confirm';
  end if;
  if not exists (select 1 from pipes where pipe_code = pc) then
    raise exception 'Reel not found: %', pc;
  end if;

  foreach sec in array array['Baseline','Braidline','Coverline'] loop
    parts := parts || jsonb_build_array(_reset_section_rows(pc, sec));
  end loop;

  if coalesce(p_include_log, false) then
    with d as (delete from notes           where pipe_code = pc returning 1) select count(*) into n_no from d;
    with d as (delete from problem_reports where pipe_code = pc returning 1) select count(*) into n_pr from d;
  end if;

  update pipes set overall_status = 'Active' where pipe_code = pc;
  perform _recompute_reel_summary(pc);
  perform _touch_pipe(pc);

  return _with_pipe(p_token, pc, jsonb_build_object(
    'sections', parts, 'notes', n_no, 'problemReports', n_pr,
    'photosKept', (select count(*) from photos where pipe_code = pc)));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Hand extruder runs to the front end with everything else
-- ---------------------------------------------------------------------------
create or replace function api_get_pipe(p_token text, p_pipe_code text)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions
as $$
declare
  pc text := trim(coalesce(p_pipe_code,''));
  pp pipes;
  ww work_orders;
begin
  perform _require(p_token, array['Admin','Operator']);

  select * into pp from pipes where pipe_code = pc;
  if pp.pipe_code is null then raise exception 'Reel not found: %', pc; end if;
  select * into ww from work_orders where code = pp.work_order_code;
  if ww.code is null then raise exception 'Work order not found for reel: %', pc; end if;

  return jsonb_build_object(
    'pipe',       _pipe_json(pp),
    'workOrder',  _wo_json(ww),
    'readings',         coalesce((select jsonb_agg(_reading_json(r)   order by r.ts)        from readings r         where r.pipe_code = pc), '[]'::jsonb),
    'thicknessChecks',  coalesce((select jsonb_agg(_thickness_json(c) order by c.ts)        from thickness_checks c where c.pipe_code = pc), '[]'::jsonb),
    'notes',            coalesce((select jsonb_agg(_note_json(n)      order by n.ts)        from notes n            where n.pipe_code = pc), '[]'::jsonb),
    'photos',           coalesce((select jsonb_agg(_photo_json(ph)    order by ph.ts)       from photos ph          where ph.pipe_code = pc), '[]'::jsonb),
    'materialUsage',    coalesce((select jsonb_agg(_material_json(m)  order by m.ts)        from material_usage m   where m.pipe_code = pc), '[]'::jsonb),
    'problemReports',   coalesce((select jsonb_agg(_problem_json(pr)  order by pr.ts)       from problem_reports pr where pr.pipe_code = pc), '[]'::jsonb),
    'downtimeEvents',   coalesce((select jsonb_agg(_downtime_json(d)  order by d.start_time) from downtime_events d where d.pipe_code = pc), '[]'::jsonb),
    'extruderRuns',     coalesce((select jsonb_agg(_extruder_json(e)  order by e.ts)        from extruder_runs e    where e.pipe_code = pc), '[]'::jsonb),
    'siblingPipes',     coalesce((select jsonb_agg(_pipe_json(sp)     order by sp.pipe_code) from pipes sp          where sp.work_order_code = pp.work_order_code), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Helpers stay unreachable; 06_harden revokes anything starting with _.
-- ---------------------------------------------------------------------------
grant execute on function api_add_extruder_run(text,text,text,text,timestamptz,numeric,numeric,numeric,numeric,numeric,text) to anon, authenticated;
grant execute on function api_reset_section(text,text,text,text)   to anon, authenticated;
grant execute on function api_reset_pipe(text,text,text,boolean)   to anon, authenticated;

revoke all on function _extruder_json(extruder_runs)        from public, anon, authenticated;
revoke all on function _reset_section_rows(text,text)       from public, anon, authenticated;

-- Verify.
select
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='extruder_runs')              as extruder_table,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in
      ('api_add_extruder_run','api_reset_section','api_reset_pipe'))         as new_api_functions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like '\_%'
      and has_function_privilege('anon', p.oid, 'execute'))                  as helpers_anon_can_call,
  (select relrowsecurity from pg_class where relname='extruder_runs')        as extruder_rls;

-- ---------------------------------------------------------------------------
-- Re-harden. REQUIRED, not optional.
-- ---------------------------------------------------------------------------
-- This file replaces _recompute_reel_summary and creates _extruder_json and
-- _reset_section_rows, none of which declare a search_path. CREATE OR REPLACE also drops
-- any setting the new definition doesn't restate, so replacing a function silently
-- un-pins it. Same loop as 06_harden.sql; every migration that touches a function ends
-- with it.
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
end $$;

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

-- Expect both 0.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c
                      where c='search_path=public, extensions'))   as wrong_search_path,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like '\_%'
      and has_function_privilege('anon', p.oid,'execute'))         as helpers_anon_can_call;
