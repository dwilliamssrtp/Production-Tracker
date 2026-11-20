-- SRTP Production Tracker — arranging reels on the dashboard
-- Applied to the LIVE project mkgbaprutwznmvegpqak on 2026-11-20.
--
-- Reels were listed newest-activity-first, which is useless for organising a job: the
-- order jumps around as readings come in. An explicit order, set by dragging, holds still.
-- Null means "never arranged" and keeps the old behaviour.

alter table pipes add column if not exists sort_order integer;

-- One call sets the complete final order of one work order's reel list.
--
-- It takes the whole list rather than a single move because that is what the screen knows
-- after a drop, and because sending the end state makes the call idempotent: a retry after
-- a dropped connection lands the same way instead of shuffling the list again.
--
-- It also reassigns work_order_code, so dragging a reel onto another work order's card
-- moves it. A reel logged against the wrong job otherwise had to be deleted and retyped.
create or replace function api_set_pipe_order(p_token text, p_work_order_code text, p_pipe_codes jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  wo_code text := trim(coalesce(p_work_order_code, ''));
  ww      work_orders;
  codes   text[];
  moved   int := 0;
  i       int;
  src     work_orders;
begin
  perform _require(p_token, array['Admin']);
  select * into ww from work_orders where code = wo_code;
  if ww.code is null then raise exception 'Work order not found: %', wo_code; end if;

  select array_agg(value::text order by ordinality)
    into codes
    from jsonb_array_elements_text(coalesce(p_pipe_codes, '[]'::jsonb)) with ordinality;
  if codes is null then raise exception 'No reels given'; end if;

  for i in 1 .. array_length(codes, 1) loop
    -- Every code must exist, or a typo would silently reorder a shorter list.
    if not exists (select 1 from pipes where pipe_code = codes[i]) then
      raise exception 'Reel not found: %', codes[i];
    end if;
    -- A historical record and a live job are different kinds of thing; mixing reels
    -- between them would put reconstructed rows into a running record, or vice versa.
    select w.* into src from pipes p join work_orders w on w.code = p.work_order_code
      where p.pipe_code = codes[i];
    if src.historical <> ww.historical then
      raise exception 'Reel % belongs to a % work order and cannot move to a % one',
        codes[i],
        case when src.historical then 'historical' else 'live' end,
        case when ww.historical  then 'historical' else 'live'  end;
    end if;
    if src.code <> wo_code then moved := moved + 1; end if;
  end loop;

  for i in 1 .. array_length(codes, 1) loop
    update pipes set sort_order = i, work_order_code = wo_code, last_updated = now()
     where pipe_code = codes[i]
       and (sort_order is distinct from i or work_order_code is distinct from wo_code);
  end loop;

  return jsonb_build_object('workOrderCode', wo_code, 'count', array_length(codes,1), 'moved', moved);
end;
$$;

grant execute on function api_set_pipe_order(text,text,jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- api_dashboard was PATCHED, not rewritten
-- ---------------------------------------------------------------------------
-- Its payload keys are read directly by the front end, so the body is modified in place.
-- Three changes, each anchored on a SHORT SINGLE-LINE fragment with the match count
-- asserted before executing — the stored body uses \r\n, so a multi-line search string
-- silently matches nothing and reports success:
--
--   p.overall_status, p.last_updated, p.archived,        ->  ... , p.sort_order,
--   pr.overall_status, pr.cv_actual_length, pr...,       ->  ... , pr.sort_order,
--   order by b.last_updated desc              (x2)       ->  order by b.sort_order nulls last,
--                                                            b.last_updated desc
--
-- Arranged reels hold their place; the rest keep the old newest-first behaviour.

-- ---------------------------------------------------------------------------
-- Re-harden. REQUIRED — see 06_harden.sql.
-- ---------------------------------------------------------------------------
-- Scoped to the tracker's own functions: this project is shared with the pricing tool,
-- whose functions are not ours to re-pin.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as fn from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like any (array['api\_%', '\_%'])
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c
                      where c = 'search_path=public, extensions')
  loop execute format('alter function %s set search_path = public, extensions', r.fn); end loop;

  for r in select p.oid::regprocedure as fn from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '\_%'
  loop execute format('revoke all on function %s from public, anon, authenticated', r.fn); end loop;
end $$;

-- Expect sort_column 1, dashboard_patched 1, helpers_anon_can_call 0.
select
  (select count(*) from information_schema.columns
    where table_name = 'pipes' and column_name = 'sort_order')        as sort_column,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_dashboard'
      and prosrc like '%b.sort_order nulls last%')                    as dashboard_patched,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '\_%'
      and has_function_privilege('anon', p.oid, 'execute'))           as helpers_anon_can_call;
