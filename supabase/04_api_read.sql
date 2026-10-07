-- SRTP Production Tracker — read API
-- Run after 03_seed.sql.
--
-- These functions return the exact JSON shapes index.html already consumes: PascalCase
-- keys, `''` rather than null for empty numbers and dates. That is deliberate — the front
-- end is 4,000 lines of working, tested code, and making the database speak its language
-- is far cheaper and safer than rewriting every consumer to speak the database's.
--
-- Columns are snake_case in the tables (Postgres convention) and translated here, in one
-- place, where the mapping is visible and reviewable.

-- ---------------------------------------------------------------------------
-- Null handling
-- ---------------------------------------------------------------------------
-- The Sheet had no nulls — an empty cell read as ''. The front end checks for '' all over
-- the place (fmtTol, "is there a footage marker", "has this section started"). Emitting
-- JSON null instead would make empty values render as the word "null" in a dozen places,
-- so empties are normalised to '' on the way out and the front end never has to know the
-- storage changed underneath it.

create or replace function _jn(v numeric)
returns jsonb language sql immutable as $$
  select case when v is null then '""'::jsonb else to_jsonb(v) end
$$;

create or replace function _jt(v timestamptz)
returns jsonb language sql immutable as $$
  select case when v is null then '""'::jsonb else to_jsonb(v) end
$$;

create or replace function _js(v text)
returns jsonb language sql immutable as $$
  select to_jsonb(coalesce(v, ''))
$$;

-- ---------------------------------------------------------------------------
-- Row shapes
-- ---------------------------------------------------------------------------

create or replace function _wo_json(w work_orders)
returns jsonb language sql stable as $$
  -- The recipe/target fields live in `spec` and are merged up to the top level, so the
  -- front end still reads wo.BL_TargetOD, wo.BR_LongsMaterial and so on exactly as before.
  select coalesce(w.spec, '{}'::jsonb) || jsonb_build_object(
    'Code',          w.code,
    'CreatedAt',     _jt(w.created_at),
    'CreatedBy',     _js(w.created_by),
    'Customer',      _js(w.customer),
    'ProductCode',   _js(w.product_code),
    'PipeSize',      _js(w.pipe_size),
    'EmailTo',       _js(w.email_to),
    'ProjectLength', _jn(w.project_length),
    'Archived',      to_jsonb(w.archived),
    'ArchivedAt',    _jt(w.archived_at),
    'ArchivedBy',    _js(w.archived_by),
    'LastUpdated',   _jt(w.last_updated)
  )
$$;

create or replace function _pipe_json(p pipes)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'PipeCode',          p.pipe_code,
    'WorkOrderCode',     p.work_order_code,
    'CreatedAt',         _jt(p.created_at),
    'CreatedBy',         _js(p.created_by),
    'BL_Status',         _js(p.bl_status),
    'BL_StartedAt',      _jt(p.bl_started_at),
    'BL_CompletedAt',    _jt(p.bl_completed_at),
    'BL_ActualLength',   _jn(p.bl_actual_length),
    'BR_Status',         _js(p.br_status),
    'BR_StartedAt',      _jt(p.br_started_at),
    'BR_CompletedAt',    _jt(p.br_completed_at),
    'BR_ActualLength',   _jn(p.br_actual_length),
    'CV_Status',         _js(p.cv_status),
    'CV_StartedAt',      _jt(p.cv_started_at),
    'CV_CompletedAt',    _jt(p.cv_completed_at),
    'CV_ActualLength',   _jn(p.cv_actual_length),
    'OverallStatus',     _js(p.overall_status),
    'LastUpdated',       _jt(p.last_updated),
    'LastEmailAt',       _jt(p.last_email_at),
    'BL_LastFootage',    _jn(p.bl_last_footage),
    'BR_LastFootage',    _jn(p.br_last_footage),
    'CV_LastFootage',    _jn(p.cv_last_footage)
  )
$$;

create or replace function _reading_json(r readings)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'RowId',           r.id,
    'PipeCode',        r.pipe_code,
    'Section',         _js(r.section),
    'Timestamp',       _jt(r.ts),
    'Operator',        _js(r.operator),
    'Type',            _js(r.type),
    'Value',           _jn(r.value),
    'InTol',           _js(r.in_tol),
    'Footage',         _jn(r.footage),
    'EnteredAt',       _jt(r.entered_at),
    'TimeSource',      _js(r.time_source),
    'TimeOffsetMin',   to_jsonb(r.time_offset_min),
    'VoidStatus',      _js(r.void_status),
    'VoidReason',      _js(r.void_reason),
    'VoidRequestedBy', _js(r.void_requested_by),
    'VoidRequestedAt', _jt(r.void_requested_at),
    'VoidedBy',        _js(r.voided_by),
    'VoidedAt',        _jt(r.voided_at)
  )
$$;

-- Wall points are stored as an array. The front end reads c.T1 … c.T16, so both shapes go
-- out: `Points` for anything written from here on, and the T-keys so none of the existing
-- chart, table and matrix code has to change.
create or replace function _thickness_json(c thickness_checks)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'RowId',           c.id,
    'PipeCode',        c.pipe_code,
    'Section',         _js(c.section),
    'Position',        _js(c.position),
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
    'VoidedAt',        _jt(c.voided_at)
  )
  || coalesce((
    select jsonb_object_agg('T' || i, _jn(c.points[i]))
    from generate_series(1, coalesce(array_length(c.points, 1), 0)) i
  ), '{}'::jsonb)
$$;

create or replace function _note_json(n notes)
returns jsonb language sql stable as $$
  select jsonb_build_object('RowId', n.id, 'PipeCode', n.pipe_code, 'Section', _js(n.section),
    'Timestamp', _jt(n.ts), 'Operator', _js(n.operator), 'Text', _js(n.text))
$$;

create or replace function _photo_json(p photos)
returns jsonb language sql stable as $$
  select jsonb_build_object('RowId', p.id, 'PipeCode', p.pipe_code, 'Section', _js(p.section),
    'Timestamp', _jt(p.ts), 'Operator', _js(p.operator), 'Caption', _js(p.caption),
    'StoragePath', _js(p.storage_path),
    'DriveUrl', _js(p.drive_url), 'DriveFileId', _js(p.drive_file_id),
    'ProblemReportId', coalesce(to_jsonb(p.problem_report_id), '""'::jsonb))
$$;

create or replace function _material_json(m material_usage)
returns jsonb language sql stable as $$
  select jsonb_build_object('RowId', m.id, 'PipeCode', m.pipe_code, 'Section', _js(m.section),
    'Timestamp', _jt(m.ts), 'Operator', _js(m.operator), 'Material', _js(m.material),
    'LotNumber', _js(m.lot_number), 'StartWeight', _jn(m.start_weight),
    'EndWeight', _jn(m.end_weight), 'UsedWeight', _jn(m.used_weight))
$$;

create or replace function _problem_json(p problem_reports)
returns jsonb language sql stable as $$
  select jsonb_build_object('RowId', p.id, 'PipeCode', p.pipe_code, 'Section', _js(p.section),
    'Timestamp', _jt(p.ts), 'Operator', _js(p.operator), 'FootageMarker', _jn(p.footage_marker),
    'Description', _js(p.description), 'Status', _js(p.status), 'ResolvedBy', _js(p.resolved_by),
    'ResolvedAt', _jt(p.resolved_at), 'ResolutionNotes', _js(p.resolution_notes))
$$;

create or replace function _downtime_json(d downtime_events)
returns jsonb language sql stable as $$
  select jsonb_build_object('RowId', d.id, 'PipeCode', d.pipe_code, 'Section', _js(d.section),
    'StartTime', _jt(d.start_time), 'EndTime', _jt(d.end_time), 'ReasonCode', _js(d.reason_code),
    'Notes', _js(d.notes), 'Operator', _js(d.operator))
$$;

-- ---------------------------------------------------------------------------
-- One reel, everything about it
-- ---------------------------------------------------------------------------
--
-- This is the request the operator view makes constantly, and the one that was worst on
-- Sheets: it read seven history sheets in full — every row of every work order ever
-- entered — to find the few hundred rows belonging to one reel. Here each of those is an
-- index lookup on pipe_code.

create or replace function api_get_pipe(p_token text, p_pipe_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pc text := trim(coalesce(p_pipe_code, ''));
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
    'siblingPipes',     coalesce((select jsonb_agg(_pipe_json(sp)     order by sp.pipe_code) from pipes sp          where sp.work_order_code = pp.work_order_code), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- The board
-- ---------------------------------------------------------------------------

-- Running/down time for a section that's in progress. Mirrors computeProdTiming_ from the
-- Apps Script version exactly, including that downtime is summed from events and an open
-- event means the line is down right now.
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

  target_len := nullif(w.spec ->> (upper(prefix) || '_TargetLength'), '')::numeric;
  line_speed := nullif(w.spec ->> (upper(prefix) || '_LineSpeed'), '')::numeric;
  if target_len is not null and line_speed is not null and line_speed > 0 then
    expected := to_jsonb(round(target_len / line_speed, 4));
  end if;

  return jsonb_build_object(
    'status',          case when open_evt.id is not null then 'down' else 'running' end,
    'downReason',      _js(open_evt.reason_code),
    'downNotes',       _js(open_evt.notes),
    'downSince',       _jt(open_evt.start_time),
    'runningMinutes',  round(greatest(0, total_minutes - down_minutes), 4),
    'downMinutes',     round(down_minutes, 4),
    'expectedMinutes', expected
  );
end;
$$;

-- Progress through a section, for the TV view's three bars: how far down the reel the last
-- OD check was taken, against the section's target length. A finished section reads 100%
-- from its actual length, since the last check is never at the very end.
create or replace function _section_progress(p pipes, w work_orders, p_section text)
returns jsonb
language plpgsql
stable
as $$
declare
  prefix  text := case p_section when 'Baseline' then 'bl' when 'Braidline' then 'br' else 'cv' end;
  status  text;
  target  numeric;
  footage numeric;
  actual  numeric;
begin
  status := case prefix when 'bl' then p.bl_status when 'br' then p.br_status else p.cv_status end;
  target := nullif(w.spec ->> (upper(prefix) || '_TargetLength'), '')::numeric;

  if status = 'Complete' then
    actual := case prefix when 'bl' then p.bl_actual_length when 'br' then p.br_actual_length else p.cv_actual_length end;
    return jsonb_build_object('status', status, 'pct', 100,
      'length', _jn(actual), 'target', _jn(target));
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
    'target', _jn(target)
  );
end;
$$;

create or replace function api_dashboard(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  groups jsonb;
begin
  perform _require(p_token, array['Admin']);

  with pipe_rows as (
    -- The pipe and work order rows are carried whole (`p as pipe_row`) rather than
    -- expanded with p.*, because _prod_timing and _section_progress take a `pipes` and a
    -- `work_orders` row. Expanding and casting back fails: the row would also carry the
    -- joined work-order columns, and Postgres refuses the cast as having too many columns.
    -- Joining work_orders directly rather than through a CTE keeps `w` a true work_orders
    -- row, so no cast is needed at all.
    select p as pipe_row, w as wo_row,
           w.code as wo_code, w.customer, w.product_code, w.project_length,
           p.pipe_code, p.bl_status, p.br_status, p.cv_status,
           p.overall_status, p.last_updated,
           p.bl_actual_length, p.br_actual_length, p.cv_actual_length,
           p.last_reading_at, p.last_reading_type, p.last_reading_value, p.last_reading_in_tol
    from pipes p
    join work_orders w on w.code = p.work_order_code and not w.archived
  ),
  open_problems as (
    select pr.pipe_code, count(*)::int as n
    from problem_reports pr where pr.status = 'Open' group by pr.pipe_code
  ),
  built as (
    select
      pr.wo_code, pr.customer, pr.product_code, pr.project_length, pr.pipe_code,
      pr.overall_status, pr.cv_actual_length, pr.last_updated,
      jsonb_build_object(
        'pipeCode',        pr.pipe_code,
        'blStatus',        pr.bl_status,
        'brStatus',        pr.br_status,
        'cvStatus',        pr.cv_status,
        'overallStatus',   pr.overall_status,
        'lastUpdated',     _jt(pr.last_updated),
        'blActualLength',  _jn(pr.bl_actual_length),
        'brActualLength',  _jn(pr.br_actual_length),
        'cvActualLength',  _jn(pr.cv_actual_length),
        'openProblems',    coalesce(op.n, 0),
        'lastReading',     case when pr.last_reading_at is null then null else jsonb_build_object(
                              'Timestamp', _jt(pr.last_reading_at),
                              'Type',      _js(pr.last_reading_type),
                              'Value',     _jn(pr.last_reading_value),
                              'InTol',     _js(pr.last_reading_in_tol)) end,
        'prodSection',     case when pr.cv_status = 'In progress' then 'Coverline'
                                when pr.br_status = 'In progress' then 'Braidline'
                                when pr.bl_status = 'In progress' then 'Baseline' else null end,
        'prodTiming',      case when pr.cv_status = 'In progress' then _prod_timing(pr.pipe_row, pr.wo_row, 'Coverline')
                                when pr.br_status = 'In progress' then _prod_timing(pr.pipe_row, pr.wo_row, 'Braidline')
                                when pr.bl_status = 'In progress' then _prod_timing(pr.pipe_row, pr.wo_row, 'Baseline') else null end,
        'sectionProgress', jsonb_build_object(
                              'Baseline',  _section_progress(pr.pipe_row, pr.wo_row, 'Baseline'),
                              'Braidline', _section_progress(pr.pipe_row, pr.wo_row, 'Braidline'),
                              'Coverline', _section_progress(pr.pipe_row, pr.wo_row, 'Coverline'))
      ) as pipe_json
    from pipe_rows pr
    left join open_problems op on op.pipe_code = pr.pipe_code
  ),
  grouped as (
    select
      b.wo_code as "workOrderCode",
      max(b.customer) as customer,
      max(b.product_code) as "productCode",
      max(b.project_length) as project_length,
      jsonb_agg(b.pipe_json order by b.last_updated desc) as pipes,
      coalesce(jsonb_agg(b.pipe_json order by b.last_updated desc)
               filter (where b.overall_status <> 'Complete'), '[]'::jsonb) as active_pipes,
      coalesce(sum(coalesce(b.cv_actual_length, 0)), 0) as produced_length,
      coalesce(sum((b.pipe_json ->> 'openProblems')::int), 0) as open_problems,
      max(b.last_updated) as newest
    from built b
    group by b.wo_code
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'workOrderCode', g."workOrderCode",
           'customer',      _js(g.customer),
           'productCode',   _js(g."productCode"),
           'projectLength', _jn(g.project_length),
           'producedLength', round(g.produced_length, 4),
           'openProblems',  g.open_problems,
           'pipes',         g.pipes,
           'activePipes',   g.active_pipes
         ) order by g.newest desc), '[]'::jsonb)
    into groups
  from grouped g;

  return jsonb_build_object(
    'active',         coalesce((select jsonb_agg(x) from jsonb_array_elements(groups) x
                                where jsonb_array_length(x -> 'activePipes') > 0), '[]'::jsonb),
    'recentComplete', coalesce((select jsonb_agg(x) from jsonb_array_elements(groups) x
                                where jsonb_array_length(x -> 'activePipes') = 0), '[]'::jsonb),
    'serverTime',     to_jsonb(now())
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Smaller reads
-- ---------------------------------------------------------------------------

create or replace function api_get_work_order_info(p_token text, p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ww work_orders;
begin
  perform _require(p_token, array['Admin']);
  select * into ww from work_orders where code = trim(coalesce(p_code, ''));
  if ww.code is null then raise exception 'Work order not found: %', p_code; end if;

  return jsonb_build_object(
    'workOrder', _wo_json(ww),
    'pipes', coalesce((select jsonb_agg(_pipe_json(p) order by p.pipe_code)
                       from pipes p where p.work_order_code = ww.code), '[]'::jsonb)
  );
end;
$$;

create or replace function api_list_archive(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform _require(p_token, array['Admin']);
  return jsonb_build_object('workOrders', coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', w.code, 'customer', _js(w.customer), 'productCode', _js(w.product_code),
      'pipeSize', _js(w.pipe_size), 'projectLength', _jn(w.project_length),
      'createdAt', _jt(w.created_at), 'archivedAt', _jt(w.archived_at), 'archivedBy', _js(w.archived_by),
      'pipeCount', (select count(*) from pipes p where p.work_order_code = w.code),
      'pipeCodes', coalesce((select jsonb_agg(p.pipe_code order by p.pipe_code) from pipes p where p.work_order_code = w.code), '[]'::jsonb),
      'completePipes', (select count(*) from pipes p where p.work_order_code = w.code and p.overall_status = 'Complete')
    ) order by w.archived_at desc)
    from work_orders w where w.archived
  ), '[]'::jsonb));
end;
$$;

create or replace function api_admin_panel(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform _require(p_token, array['Admin']);
  return jsonb_build_object(
    'accounts',    api_list_accounts(p_token) -> 'accounts',
    'operatorKey', coalesce((select value from settings where key = 'OperatorQrKey'), ''),
    -- Backups are Supabase's job now, not a button in this app: the platform takes daily
    -- snapshots of the whole database. Reported here so the panel has something true to
    -- say rather than a control that no longer means anything.
    'backup',      jsonb_build_object('managedBySupabase', true)
  );
end;
$$;

-- What a permanent delete would destroy, counted before anyone agrees to it.
create or replace function api_work_order_delete_preview(p_token text, p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ww work_orders;
  codes text[];
begin
  perform _require(p_token, array['Admin']);
  select * into ww from work_orders where code = trim(coalesce(p_code, ''));
  if ww.code is null then raise exception 'Work order not found: %', p_code; end if;

  select coalesce(array_agg(p.pipe_code), '{}') into codes from pipes p where p.work_order_code = ww.code;

  return jsonb_build_object(
    'code', ww.code,
    'archived', ww.archived,
    'pipeCodes', to_jsonb(codes),
    'counts', jsonb_build_object(
      'pipes',           coalesce(array_length(codes, 1), 0),
      'readings',        (select count(*) from readings         where pipe_code = any(codes)),
      'thicknessChecks', (select count(*) from thickness_checks where pipe_code = any(codes)),
      'notes',           (select count(*) from notes            where pipe_code = any(codes)),
      'photos',          (select count(*) from photos           where pipe_code = any(codes)),
      'materialUsage',   (select count(*) from material_usage   where pipe_code = any(codes)),
      'problemReports',  (select count(*) from problem_reports  where pipe_code = any(codes)),
      'downtimeEvents',  (select count(*) from downtime_events  where pipe_code = any(codes))
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function _jn(numeric), _jt(timestamptz), _js(text) from public, anon, authenticated;

grant execute on function api_get_pipe(text, text)                   to anon, authenticated;
grant execute on function api_dashboard(text)                        to anon, authenticated;
grant execute on function api_get_work_order_info(text, text)        to anon, authenticated;
grant execute on function api_list_archive(text)                     to anon, authenticated;
grant execute on function api_admin_panel(text)                      to anon, authenticated;
grant execute on function api_work_order_delete_preview(text, text)  to anon, authenticated;

-- Verification — should list the api_ functions you now have.
select proname as api_function
from pg_proc
where proname like 'api\_%'
order by proname;
