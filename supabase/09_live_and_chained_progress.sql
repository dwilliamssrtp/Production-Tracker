-- SRTP Production Tracker — live updates, and progress chained to actual production
-- Run after 08_multilayer.sql. Idempotent.
--
-- 1. _effective_target_length — a downstream section runs what the section before it
--    actually made, not what the work order hoped for.
-- 2. api_pulse — a cheap heartbeat so open screens notice changes in seconds.

-- ---------------------------------------------------------------------------
-- 1. Chained progress
-- ---------------------------------------------------------------------------
-- The work-order target length is what we HOPED to get off the reel. Once Baseline
-- finishes and reports an actual length, that number is what Braidline has to braid, and
-- Braidline's actual is what Coverline has to cover. Measuring a downstream section
-- against the original target made a reel that came up short look permanently incomplete:
-- 820 ft braided against a 1000 ft target reads 82% and never reaches 100%, even when the
-- section is genuinely finished.
--
-- Falls back to the work-order target while the upstream section is still running — that
-- is the only sensible reference before an actual exists, and it is why the work order's
-- length is a reference rather than a commitment.
--
-- effectiveTargetLength() in index.html mirrors this. The two must agree, or the same reel
-- reads differently on the operator screen and the dashboard.
create or replace function _effective_target_length(p pipes, w work_orders, p_section text)
returns jsonb
language sql
stable
as $$
  select case p_section
    when 'Baseline' then
      jsonb_build_object('target', _jn(nullif(w.spec ->> 'BL_TargetLength','')::numeric), 'source', 'reference')
    when 'Braidline' then
      case when p.bl_actual_length is not null
        then jsonb_build_object('target', _jn(p.bl_actual_length), 'source', 'Baseline')
        else jsonb_build_object('target', _jn(nullif(w.spec ->> 'BR_TargetLength','')::numeric), 'source', 'reference') end
    else
      case when p.br_actual_length is not null
        then jsonb_build_object('target', _jn(p.br_actual_length), 'source', 'Braidline')
        else jsonb_build_object('target', _jn(nullif(w.spec ->> 'CV_TargetLength','')::numeric), 'source', 'reference') end
  end
$$;

create or replace function _section_progress(p pipes, w work_orders, p_section text)
returns jsonb
language plpgsql
stable
as $$
declare
  prefix  text := case p_section when 'Baseline' then 'bl' when 'Braidline' then 'br' else 'cv' end;
  status  text;
  eff     jsonb;
  target  numeric;
  footage numeric;
  actual  numeric;
begin
  status := case prefix when 'bl' then p.bl_status when 'br' then p.br_status else p.cv_status end;
  eff    := _effective_target_length(p, w, p_section);
  target := nullif(eff ->> 'target', '')::numeric;

  if status = 'Complete' then
    actual := case prefix when 'bl' then p.bl_actual_length when 'br' then p.br_actual_length else p.cv_actual_length end;
    return jsonb_build_object('status', status, 'pct', 100,
      'length', _jn(actual), 'target', _jn(target), 'targetSource', eff ->> 'source');
  end if;

  footage := case prefix when 'bl' then p.bl_last_footage when 'br' then p.br_last_footage else p.cv_last_footage end;

  return jsonb_build_object(
    'status', status,
    -- null, not zero, when there's nothing to go on: "we don't know" and "nothing has run"
    -- look identical as an empty bar, and on a wall display people act on that difference.
    'pct', case when target is not null and target > 0 and footage is not null
                then least(100, greatest(0, round(100 * footage / target)))
                else null end,
    'length', _jn(footage),
    'target', _jn(target),
    'targetSource', eff ->> 'source');
end;
$$;

-- Expected run time follows the same rule: how long a section should take depends on how
-- much pipe it actually has to run.
create or replace function _prod_timing(p pipes, w work_orders, p_section text)
returns jsonb
language plpgsql
stable
as $$
declare
  prefix        text := case p_section when 'Baseline' then 'bl' when 'Braidline' then 'br' else 'cv' end;
  status        text;
  started       timestamptz;
  down_minutes  numeric := 0;
  open_evt      downtime_events;
  total_minutes numeric;
  target_len    numeric;
  line_speed    numeric;
  expected      jsonb := '""'::jsonb;
begin
  status  := case prefix when 'bl' then p.bl_status     when 'br' then p.br_status     else p.cv_status end;
  started := case prefix when 'bl' then p.bl_started_at when 'br' then p.br_started_at else p.cv_started_at end;
  if status <> 'In progress' or started is null then return null; end if;

  select coalesce(sum(extract(epoch from (coalesce(d.end_time, now()) - d.start_time)) / 60.0), 0)
    into down_minutes
    from downtime_events d
   where d.pipe_code = p.pipe_code and d.section = p_section;

  select * into open_evt
    from downtime_events d
   where d.pipe_code = p.pipe_code and d.section = p_section and d.end_time is null
   order by d.start_time desc limit 1;

  total_minutes := greatest(0, extract(epoch from (now() - started)) / 60.0);

  target_len := nullif(_effective_target_length(p, w, p_section) ->> 'target', '')::numeric;
  line_speed := nullif(w.spec ->> (upper(prefix) || '_LineSpeed'), '')::numeric;
  if target_len is not null and line_speed is not null and line_speed > 0 then
    expected := to_jsonb(round(target_len / line_speed, 4));
  end if;

  return jsonb_build_object(
    'status',         case when open_evt.id is not null then 'down' else 'running' end,
    'downReason',     _js(coalesce(open_evt.reason_code, '')),
    'downNotes',      _js(coalesce(open_evt.notes, '')),
    'downSince',      _jt(open_evt.start_time),
    'runningMinutes', round(greatest(0, total_minutes - down_minutes), 4),
    'downMinutes',    round(down_minutes, 4),
    'expectedMinutes', expected);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The heartbeat
-- ---------------------------------------------------------------------------
-- Every screen used to refetch its whole payload on a 20-second timer: slow to notice a
-- reading logged on a phone, and wasteful the rest of the time. This returns one number
-- instead — the newest last_updated across all reels, which every write bumps via
-- _touch_pipe. The browser polls this every few seconds and refetches real data only when
-- the number moves.
--
-- Polling rather than Supabase Realtime on purpose. Realtime's Postgres Changes would
-- require the browser to hold a SELECT policy on the tables it watches, and the whole
-- security model here is that no table is readable directly — the api_ functions are the
-- only way in. Trading that away to save a few seconds of latency is a bad deal.
create or replace function api_pulse(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions
as $$
begin
  perform _require(p_token, array['Admin','Operator']);
  return jsonb_build_object(
    'v', coalesce(extract(epoch from (select max(last_updated) from pipes)), 0),
    'n', (select count(*) from pipes),
    'w', (select count(*) from work_orders where not archived));
end;
$$;

grant execute on function api_pulse(text) to anon, authenticated;
revoke all on function _effective_target_length(pipes, work_orders, text) from public, anon, authenticated;

-- Verify. Expect pulse_fn 1, helpers_anon_can_call 0.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='api_pulse')                     as pulse_fn,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like '\_%'
      and has_function_privilege('anon', p.oid,'execute'))                  as helpers_anon_can_call;
