-- SRTP Production Tracker — multilayer baseline thickness checks
-- Run after 07_extruders_reset.sql. Idempotent.
--
-- Some baseline pipe is run as two layers and the useful measurement is each layer, not
-- just the wall they add up to. Rather than a second kind of thickness check, the existing
-- one gains a `layer` column: the operator takes one clock face per layer, which is the
-- entry they already know.
--
-- Whether a work order is two-layer is declared once on the work order (spec key
-- BL_Layers = '2'), because most jobs are single layer and a Layer selector on every reel
-- that will never use it is clutter on the one card operators use most.
--
-- '' means the whole wall. Every check recorded before this is '' and every single-layer
-- job keeps sending '', so nothing already in the table changes meaning.

alter table thickness_checks add column if not exists layer text not null default '';

create or replace function _thickness_json(c thickness_checks)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'RowId',           c.id,
    'PipeCode',        c.pipe_code,
    'Section',         _js(c.section),
    'Position',        _js(c.position),
    'Layer',           _js(c.layer),
    'Timestamp',       _jt(c.ts),
    'Operator',        _js(c.operator),
    'OD',              _jn(c.od),
    'Points',          to_jsonb(c.points),
    'AvgThickness',    _jn(c.avg_thickness),
    'ComputedID',      _jn(c.computed_id),
    'Ovality',         _jn(c.ovality),
    'VoidStatus',      _js(c.void_status),
    'VoidReason',      _js(c.void_reason),
    'VoidRequestedBy', _js(c.void_requested_by),
    'VoidRequestedAt', _jt(c.void_requested_at),
    'VoidedBy',        _js(c.voided_by),
    'VoidedAt',        _jt(c.voided_at),
    'T1',  _jn(c.points[1]),  'T2',  _jn(c.points[2]),  'T3',  _jn(c.points[3]),  'T4',  _jn(c.points[4]),
    'T5',  _jn(c.points[5]),  'T6',  _jn(c.points[6]),  'T7',  _jn(c.points[7]),  'T8',  _jn(c.points[8]),
    'T9',  _jn(c.points[9]),  'T10', _jn(c.points[10]), 'T11', _jn(c.points[11]), 'T12', _jn(c.points[12]),
    'T13', _jn(c.points[13]), 'T14', _jn(c.points[14]), 'T15', _jn(c.points[15]), 'T16', _jn(c.points[16]))
$$;

create or replace function api_add_thickness_check(
  p_token text, p_pipe_code text, p_section text, p_position text,
  p_operator text, p_timestamp timestamptz, p_od numeric, p_points numeric[], p_layer text default '')
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  pc    text := trim(coalesce(p_pipe_code, ''));
  pts   numeric[] := coalesce(p_points, '{}');
  lyr   text := coalesce(p_layer, '');
  avg_t numeric;
  new_c thickness_checks;
begin
  perform _require(p_token, array['Admin','Operator']);
  if not exists (select 1 from pipes where pipe_code = pc) then raise exception 'Reel not found: %', pc; end if;

  select avg(x) into avg_t from unnest(pts) x where x is not null;

  insert into thickness_checks (pipe_code, section, position, layer, ts, operator, od, points,
                                avg_thickness, computed_id, ovality)
  values (pc, p_section, coalesce(p_position,''), lyr, coalesce(p_timestamp, now()),
          coalesce(p_operator,''), p_od, pts,
          round(avg_t, 4),
          -- ID = OD - 2 x average wall. Only meaningful for the whole wall: the average of
          -- one layer of a two-layer wall says nothing about the bore, and an ID computed
          -- from it would be confidently wrong. Layer checks carry avg and ovality only.
          -- liveThicknessCalc in the front end applies the same rule, so what the operator
          -- sees while typing matches what gets stored.
          case when p_od is null or avg_t is null or lyr not in ('', 'Full wall')
               then null else round(p_od - 2*avg_t, 4) end,
          (select round(max(x) - min(x), 4) from unnest(pts) x where x is not null))
  returning * into new_c;

  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, _thickness_json(new_c));
end;
$$;

-- The 9-arg version defaults p_layer, so a caller that omits it still resolves. Leaving
-- the old 8-arg function in place would make the call ambiguous for PostgREST and could
-- silently route a client to the version that cannot record a layer.
drop function if exists api_add_thickness_check(text,text,text,text,text,timestamptz,numeric,numeric[]);

grant execute on function api_add_thickness_check(text,text,text,text,text,timestamptz,numeric,numeric[],text) to anon, authenticated;
revoke all on function _thickness_json(thickness_checks) from public, anon, authenticated;

-- Verify. Expect layer_column 1, overloads 1, anon_can_call true.
select
  (select count(*) from information_schema.columns
    where table_name='thickness_checks' and column_name='layer')              as layer_column,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='api_add_thickness_check')         as overloads,
  (select has_function_privilege('anon', p.oid, 'execute') from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='api_add_thickness_check')         as anon_can_call;
