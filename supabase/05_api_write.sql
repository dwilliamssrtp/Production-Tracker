-- SRTP Production Tracker — write API
-- Run after 04_api_read.sql.
--
-- Every pipe-scoped write returns { data, pipe } — the result plus the reel's refreshed
-- state. That mirrors the `withPipe` flag added to the Apps Script backend for the same
-- reason: without it, every operator action was two round trips (save, then reload so the
-- screen could redraw). Here the second trip costs a few milliseconds rather than a
-- second, but it's still a round trip, and the data is already to hand.
--
-- Note on locking: Apps Script needed one global script lock serialising every write
-- across the whole plant, because two concurrent writers could overwrite each other's
-- rows. Postgres doesn't need it — each statement is already atomic and row-level locks
-- are taken automatically. Two operators on different lines no longer wait for each other
-- at all, which was a real constraint on the old backend and simply isn't one here.

-- ---------------------------------------------------------------------------
-- Internals
-- ---------------------------------------------------------------------------

create or replace function _prefix(p_section text)
returns text language sql immutable as $$
  select case p_section when 'Baseline' then 'bl' when 'Braidline' then 'br'
                        when 'Coverline' then 'cv' else null end
$$;

-- In/out of tolerance, from the work order's targets. Computed here, at write time, and
-- stored on the row — so a target edited later never silently reclassifies readings that
-- were judged against the old spec.
create or replace function _compute_in_tol(w work_orders, p_section text, p_type text, p_value numeric)
returns text
language plpgsql
stable
as $$
declare
  pfx    text := upper(_prefix(p_section));
  target numeric;
  tol    numeric;
begin
  if pfx is null then return ''; end if;
  if p_type = 'Pitch' then
    target := nullif(w.spec ->> 'BR_TargetPitch', '')::numeric;
    tol    := nullif(w.spec ->> 'BR_PitchTol', '')::numeric;
  else
    target := nullif(w.spec ->> (pfx || '_TargetOD'), '')::numeric;
    tol    := nullif(w.spec ->> (pfx || '_ODTol'), '')::numeric;
  end if;
  if target is null or tol is null then return ''; end if;
  return case when abs(p_value - target) <= tol then 'Y' else 'N' end;
end;
$$;

-- Rebuilds the reel's cached last-reading and per-section footage from the readings that
-- still count. Needed after a void: the dashboard and TV bars read these columns rather
-- than scanning readings, so striking out the newest one must not leave the board showing
-- the number that was just withdrawn.
create or replace function _recompute_reel_summary(p_pipe_code text)
returns void
language plpgsql
volatile
as $$
declare
  r readings;
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
end;
$$;

create or replace function _touch_pipe(p_pipe_code text)
returns void language sql volatile as $$
  update pipes set last_updated = now() where pipe_code = p_pipe_code;
$$;

-- Wraps a write's result with the reel's new state, so the browser needs one request.
create or replace function _with_pipe(p_token text, p_pipe_code text, p_data jsonb)
returns jsonb language sql volatile as $$
  select jsonb_build_object('data', p_data, 'pipe', api_get_pipe(p_token, p_pipe_code));
$$;

-- ---------------------------------------------------------------------------
-- Work orders
-- ---------------------------------------------------------------------------
-- p_spec carries every recipe/target field as a jsonb object keyed exactly as the front
-- end sends them (BL_TargetOD, BR_LongsMaterial, CV_ConcentricityGap …). Adding a field to
-- a recipe card needs no schema change at all.

create or replace function api_create_work_order(
  p_token text, p_code text, p_created_by text,
  p_customer text, p_product_code text, p_pipe_size text, p_email_to text,
  p_project_length numeric, p_spec jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare v_code text := trim(coalesce(p_code, ''));
begin
  perform _require(p_token, array['Admin']);
  if v_code = '' then raise exception 'Work order code is required'; end if;
  if exists (select 1 from work_orders w where w.code = v_code) then
    raise exception 'Work order code "%" already exists', v_code;
  end if;

  insert into work_orders (code, created_by, customer, product_code, pipe_size, email_to,
                           project_length, spec)
  values (v_code, coalesce(p_created_by,''), coalesce(p_customer,''), coalesce(p_product_code,''),
          coalesce(p_pipe_size,''), coalesce(p_email_to,''), p_project_length,
          coalesce(p_spec, '{}'::jsonb));

  return jsonb_build_object('code', v_code);
end;
$$;

create or replace function api_update_work_order(
  p_token text, p_code text,
  p_customer text, p_product_code text, p_pipe_size text, p_email_to text,
  p_project_length numeric, p_spec jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare v_code text := trim(coalesce(p_code, ''));
begin
  perform _require(p_token, array['Admin']);
  if not exists (select 1 from work_orders w where w.code = v_code) then
    raise exception 'Work order not found: %', v_code;
  end if;

  update work_orders set
    customer       = coalesce(p_customer, customer),
    product_code   = coalesce(p_product_code, product_code),
    pipe_size      = coalesce(p_pipe_size, pipe_size),
    email_to       = coalesce(p_email_to, email_to),
    project_length = coalesce(p_project_length, project_length),
    -- Merged, not replaced: a form that only sends the fields it shows must not wipe the
    -- ones it doesn't.
    spec           = coalesce(spec, '{}'::jsonb) || coalesce(p_spec, '{}'::jsonb),
    last_updated   = now()
  where work_orders.code = v_code;

  return jsonb_build_object('code', v_code);
end;
$$;

create or replace function api_create_pipe(p_token text, p_pipe_code text, p_work_order_code text, p_created_by text)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare pc text := trim(coalesce(p_pipe_code, '')); wc text := trim(coalesce(p_work_order_code, ''));
begin
  perform _require(p_token, array['Admin']);
  if pc = '' then raise exception 'Reel code is required'; end if;
  if not exists (select 1 from work_orders w where w.code = wc) then
    raise exception 'Work order not found: %', wc;
  end if;
  if exists (select 1 from pipes p where p.pipe_code = pc) then
    raise exception 'Reel code "%" already exists', pc;
  end if;

  insert into pipes (pipe_code, work_order_code, created_by) values (pc, wc, coalesce(p_created_by,''));
  return jsonb_build_object('pipeCode', pc, 'workOrderCode', wc);
end;
$$;

-- ---------------------------------------------------------------------------
-- Readings
-- ---------------------------------------------------------------------------

create or replace function api_add_readings(
  p_token text, p_pipe_code text, p_section text, p_operator text,
  p_timestamp timestamptz, p_time_source text, p_readings jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  pc        text := trim(coalesce(p_pipe_code, ''));
  pfx       text := _prefix(p_section);
  pp        pipes;
  ww        work_orders;
  item      jsonb;
  claimed   timestamptz;
  entered   timestamptz := now();
  offset_m  integer;
  src       text;
  val       numeric;
  foot      numeric;
  out_rows  jsonb := '[]'::jsonb;
  new_row   readings;
begin
  perform _require(p_token, array['Admin','Operator']);
  if pfx is null then raise exception 'Unknown section: %', p_section; end if;
  select * into pp from pipes where pipe_code = pc;
  if pp.pipe_code is null then raise exception 'Reel not found: %', pc; end if;
  select * into ww from work_orders where code = pp.work_order_code;
  if jsonb_array_length(coalesce(p_readings, '[]'::jsonb)) = 0 then
    raise exception 'No readings supplied';
  end if;

  claimed  := coalesce(p_timestamp, entered);
  offset_m := round(extract(epoch from (claimed - entered)) / 60.0);

  /* Timestamp provenance. The operator may legitimately change the time — you write a
     measurement down at the gauge and type it in later. But it also allows a stack of
     missed hourly checks to be back-dated at the end of a shift, which is what the hourly
     check exists to prevent. So: trust a claim of "Manual", but don't trust "Device" when
     the clock disagrees by more than a few minutes. Either it's a back-date or the tablet's
     clock is wrong, and a controller should see both. */
  src := case when coalesce(p_time_source,'Device') = 'Manual' or abs(offset_m) > 5
              then 'Manual' else 'Device' end;

  for item in select * from jsonb_array_elements(p_readings) loop
    val  := (item ->> 'value')::numeric;
    foot := nullif(item ->> 'footage', '')::numeric;

    insert into readings (pipe_code, section, ts, operator, type, value, in_tol, footage,
                          entered_at, time_source, time_offset_min)
    values (pc, p_section, claimed, coalesce(p_operator,''), item ->> 'type', val,
            _compute_in_tol(ww, p_section, item ->> 'type', val), foot,
            entered, src, offset_m)
    returning * into new_row;

    out_rows := out_rows || _reading_json(new_row);

    -- Only OD readings carry a footage marker, and only when the operator walked out and
    -- read it — so a blank must not clobber a good value.
    if (item ->> 'type') = 'OD' and foot is not null then
      execute format('update pipes set %I = $1 where pipe_code = $2', pfx || '_last_footage')
        using foot, pc;
    end if;
  end loop;

  -- Logging against a section starts it.
  execute format(
    'update pipes set %I = case when %I = ''Not started'' then ''In progress'' else %I end,
                      %I = coalesce(%I, now()) where pipe_code = $1',
    pfx||'_status', pfx||'_status', pfx||'_status', pfx||'_started_at', pfx||'_started_at')
    using pc;

  update pipes set last_reading_at = claimed, last_reading_type = (p_readings -> -1 ->> 'type'),
                   last_reading_value = (p_readings -> -1 ->> 'value')::numeric,
                   last_reading_in_tol = _compute_in_tol(ww, p_section, p_readings -> -1 ->> 'type',
                                                         (p_readings -> -1 ->> 'value')::numeric),
                   last_updated = now()
   where pipe_code = pc;

  return _with_pipe(p_token, pc, jsonb_build_object('readings', out_rows));
end;
$$;

-- ---------------------------------------------------------------------------
-- Thickness, notes, photos, material
-- ---------------------------------------------------------------------------

create or replace function api_add_thickness_check(
  p_token text, p_pipe_code text, p_section text, p_position text,
  p_operator text, p_timestamp timestamptz, p_od numeric, p_points numeric[])
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  pc    text := trim(coalesce(p_pipe_code, ''));
  pts   numeric[] := coalesce(p_points, '{}');
  avg_t numeric;
  new_c thickness_checks;
begin
  perform _require(p_token, array['Admin','Operator']);
  if not exists (select 1 from pipes where pipe_code = pc) then raise exception 'Reel not found: %', pc; end if;

  select avg(x) into avg_t from unnest(pts) x where x is not null;

  insert into thickness_checks (pipe_code, section, position, ts, operator, od, points,
                                avg_thickness, computed_id, ovality)
  values (pc, p_section, coalesce(p_position,''), coalesce(p_timestamp, now()),
          coalesce(p_operator,''), p_od, pts,
          round(avg_t, 4),
          -- ID = OD − 2 × average wall. Matches the formula already validated in the
          -- plant's existing inspection tooling.
          case when p_od is null or avg_t is null then null else round(p_od - 2*avg_t, 4) end,
          (select round(max(x) - min(x), 4) from unnest(pts) x where x is not null))
  returning * into new_c;

  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, _thickness_json(new_c));
end;
$$;

create or replace function api_add_note(p_token text, p_pipe_code text, p_section text, p_text text, p_operator text)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare pc text := trim(coalesce(p_pipe_code,'')); n notes;
begin
  perform _require(p_token, array['Admin','Operator']);
  if trim(coalesce(p_text,'')) = '' then raise exception 'Note text is required'; end if;
  insert into notes (pipe_code, section, operator, text)
  values (pc, coalesce(p_section,''), coalesce(p_operator,''), p_text) returning * into n;
  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, _note_json(n));
end;
$$;

-- The browser uploads the image straight to Supabase Storage and passes the resulting path
-- here. Nothing routes a photo through this API, which is the point: on Apps Script the
-- upload went through the backend and held the global write lock while Drive thought
-- about it, stalling every other operator's save.
create or replace function api_add_photo(
  p_token text, p_pipe_code text, p_section text, p_caption text,
  p_operator text, p_storage_path text, p_problem_report_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare pc text := trim(coalesce(p_pipe_code,'')); ph photos;
begin
  perform _require(p_token, array['Admin','Operator']);
  if trim(coalesce(p_storage_path,'')) = '' then raise exception 'storage path is required'; end if;
  insert into photos (pipe_code, section, operator, caption, storage_path, problem_report_id)
  values (pc, coalesce(p_section,''), coalesce(p_operator,''), coalesce(p_caption,''),
          p_storage_path, p_problem_report_id)
  returning * into ph;
  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, _photo_json(ph));
end;
$$;

create or replace function api_add_material_usage(
  p_token text, p_pipe_code text, p_section text, p_operator text,
  p_material text, p_lot_number text, p_start_weight numeric, p_end_weight numeric)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare pc text := trim(coalesce(p_pipe_code,'')); m material_usage;
begin
  perform _require(p_token, array['Admin','Operator']);
  insert into material_usage (pipe_code, section, operator, material, lot_number,
                              start_weight, end_weight, used_weight)
  values (pc, coalesce(p_section,''), coalesce(p_operator,''), coalesce(p_material,''),
          coalesce(p_lot_number,''), p_start_weight, p_end_weight,
          case when p_start_weight is null or p_end_weight is null then null
               else round(p_start_weight - p_end_weight, 4) end)
  returning * into m;
  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, _material_json(m));
end;
$$;

-- ---------------------------------------------------------------------------
-- Problems and downtime
-- ---------------------------------------------------------------------------

create or replace function api_add_problem_report(
  p_token text, p_pipe_code text, p_section text, p_operator text,
  p_footage_marker numeric, p_description text, p_timestamp timestamptz)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare pc text := trim(coalesce(p_pipe_code,'')); pr problem_reports;
begin
  perform _require(p_token, array['Admin','Operator']);
  if trim(coalesce(p_description,'')) = '' then raise exception 'Describe the problem'; end if;
  insert into problem_reports (pipe_code, section, ts, operator, footage_marker, description)
  values (pc, coalesce(p_section,''), coalesce(p_timestamp, now()), coalesce(p_operator,''),
          p_footage_marker, p_description)
  returning * into pr;
  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, _problem_json(pr));
end;
$$;

create or replace function api_resolve_problem_report(
  p_token text, p_report_id uuid, p_resolved_by text, p_resolution_notes text)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare pr problem_reports;
begin
  perform _require(p_token, array['Admin','Operator']);
  select * into pr from problem_reports where id = p_report_id;
  if pr.id is null then raise exception 'Problem report not found'; end if;

  update problem_reports set status = 'Resolved', resolved_by = coalesce(p_resolved_by,''),
         resolved_at = now(), resolution_notes = coalesce(p_resolution_notes,'')
   where id = p_report_id;

  perform _touch_pipe(pr.pipe_code);
  return _with_pipe(p_token, pr.pipe_code, jsonb_build_object('reportId', p_report_id));
end;
$$;

create or replace function api_start_downtime(
  p_token text, p_pipe_code text, p_section text, p_reason_code text, p_notes text, p_operator text)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare pc text := trim(coalesce(p_pipe_code,'')); d downtime_events;
begin
  perform _require(p_token, array['Admin','Operator']);
  -- One open stoppage per section at a time; a second Stop is the same stoppage.
  if exists (select 1 from downtime_events e
              where e.pipe_code = pc and e.section = p_section and e.end_time is null) then
    raise exception 'This section is already stopped';
  end if;
  insert into downtime_events (pipe_code, section, reason_code, notes, operator)
  values (pc, p_section, coalesce(p_reason_code,''), coalesce(p_notes,''), coalesce(p_operator,''))
  returning * into d;
  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, _downtime_json(d));
end;
$$;

create or replace function api_end_downtime(p_token text, p_pipe_code text, p_section text, p_operator text)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare pc text := trim(coalesce(p_pipe_code,'')); d downtime_events;
begin
  perform _require(p_token, array['Admin','Operator']);
  select * into d from downtime_events e
   where e.pipe_code = pc and e.section = p_section and e.end_time is null
   order by e.start_time desc limit 1;
  if d.id is null then raise exception 'This section is not stopped'; end if;

  update downtime_events set end_time = now() where id = d.id;
  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, jsonb_build_object('rowId', d.id));
end;
$$;

create or replace function api_set_section_status(
  p_token text, p_pipe_code text, p_section text, p_status text, p_actual_length numeric)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  pc  text := trim(coalesce(p_pipe_code,''));
  pfx text := _prefix(p_section);
  pp  pipes;
begin
  perform _require(p_token, array['Admin','Operator']);
  if pfx is null then raise exception 'Unknown section: %', p_section; end if;

  execute format('update pipes set %I = $1 where pipe_code = $2', pfx||'_status') using p_status, pc;
  if p_status = 'Complete' then
    execute format('update pipes set %I = now() where pipe_code = $1', pfx||'_completed_at') using pc;
    if p_actual_length is not null then
      execute format('update pipes set %I = $1 where pipe_code = $2', pfx||'_actual_length')
        using p_actual_length, pc;
    end if;
  end if;

  select * into pp from pipes where pipe_code = pc;
  update pipes set
    overall_status = case when pp.bl_status = 'Complete' and pp.br_status = 'Complete'
                           and pp.cv_status = 'Complete' then 'Complete' else overall_status end,
    last_updated = now()
   where pipe_code = pc;

  return _with_pipe(p_token, pc, jsonb_build_object('pipeCode', pc, 'section', p_section, 'status', p_status));
end;
$$;

-- ---------------------------------------------------------------------------
-- Voiding a measurement
-- ---------------------------------------------------------------------------
-- Never edited, never deleted — struck out, with who asked, who agreed and why. An
-- operator can only request: the measurement goes on counting until the controller
-- agrees, so nobody can make an inconvenient reading disappear on their own.

create or replace function api_request_void(
  p_token text, p_kind text, p_row_id uuid, p_reason text, p_operator text)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  acct      accounts;
  reason    text := trim(coalesce(p_reason, ''));
  is_admin  boolean;
  pc        text;
  new_state text;
  who       text;
begin
  acct := _require(p_token, array['Admin','Operator']);
  if reason = '' then raise exception 'Give a reason for voiding this'; end if;
  if p_kind not in ('reading','thickness') then raise exception 'Unknown record type: %', p_kind; end if;

  is_admin  := acct.role = 'Admin';
  who       := coalesce(nullif(trim(coalesce(p_operator,'')), ''), acct.name, acct.username);
  -- The controller is the approver, so there is nobody left to ask.
  new_state := case when is_admin then 'Void' else 'Requested' end;

  if p_kind = 'reading' then
    select r.pipe_code into pc from readings r where r.id = p_row_id;
    if pc is null then raise exception 'Record not found'; end if;
    if (select r.void_status from readings r where r.id = p_row_id) = 'Void' then
      raise exception 'That record is already voided';
    end if;
    update readings set void_status = new_state, void_reason = reason,
           void_requested_by = who, void_requested_at = now(),
           voided_by = case when is_admin then who else voided_by end,
           voided_at = case when is_admin then now() else voided_at end
     where id = p_row_id;
  else
    select c.pipe_code into pc from thickness_checks c where c.id = p_row_id;
    if pc is null then raise exception 'Record not found'; end if;
    if (select c.void_status from thickness_checks c where c.id = p_row_id) = 'Void' then
      raise exception 'That record is already voided';
    end if;
    update thickness_checks set void_status = new_state, void_reason = reason,
           void_requested_by = who, void_requested_at = now(),
           voided_by = case when is_admin then who else voided_by end,
           voided_at = case when is_admin then now() else voided_at end
     where id = p_row_id;
  end if;

  if new_state = 'Void' then perform _recompute_reel_summary(pc); end if;
  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, jsonb_build_object('rowId', p_row_id, 'status', new_state));
end;
$$;

create or replace function api_resolve_void(p_token text, p_kind text, p_row_id uuid, p_approve boolean)
returns jsonb
language plpgsql volatile security definer set search_path = public
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
  else
    raise exception 'Unknown record type: %', p_kind;
  end if;

  perform _recompute_reel_summary(pc);
  perform _touch_pipe(pc);
  return _with_pipe(p_token, pc, jsonb_build_object('rowId', p_row_id, 'status', new_state));
end;
$$;

-- ---------------------------------------------------------------------------
-- Archive and delete
-- ---------------------------------------------------------------------------

create or replace function api_archive_work_order(p_token text, p_code text)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare acct accounts;
begin
  acct := _require(p_token, array['Admin']);
  if not exists (select 1 from work_orders w where w.code = p_code) then
    raise exception 'Work order not found: %', p_code;
  end if;
  update work_orders set archived = true, archived_at = now(),
         archived_by = coalesce(acct.username,'') where code = p_code;
  return jsonb_build_object('code', p_code, 'archived', true);
end;
$$;

create or replace function api_unarchive_work_order(p_token text, p_code text)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform _require(p_token, array['Admin']);
  update work_orders set archived = false, archived_at = null, archived_by = '' where code = p_code;
  return jsonb_build_object('code', p_code, 'archived', false);
end;
$$;

create or replace function api_delete_work_order(p_token text, p_code text, p_confirm_code text)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare ww work_orders; n_pipes int;
begin
  perform _require(p_token, array['Admin']);
  select * into ww from work_orders where code = p_code;
  if ww.code is null then raise exception 'Work order not found: %', p_code; end if;

  -- Archive first, delete second — enforced here, not just on the screen, so the
  -- reversible stage cannot be skipped by calling the API directly.
  if not ww.archived then raise exception 'Archive this work order before deleting it'; end if;
  if trim(coalesce(p_confirm_code,'')) <> ww.code then
    raise exception 'Type the work order code exactly to confirm';
  end if;

  select count(*) into n_pipes from pipes where work_order_code = ww.code;
  -- Every history table cascades from pipes, and pipes cascades from the work order, so
  -- there is no chance of leaving orphaned rows behind — which on the Sheet had to be
  -- done by hand, table by table.
  delete from work_orders where code = ww.code;

  return jsonb_build_object('code', p_code, 'deleted', jsonb_build_object('pipes', n_pipes));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function _compute_in_tol(work_orders, text, text, numeric),
                       _recompute_reel_summary(text), _touch_pipe(text),
                       _with_pipe(text, text, jsonb), _prefix(text)
  from public, anon, authenticated;

grant execute on function api_create_work_order(text,text,text,text,text,text,text,numeric,jsonb) to anon, authenticated;
grant execute on function api_update_work_order(text,text,text,text,text,text,numeric,jsonb)      to anon, authenticated;
grant execute on function api_create_pipe(text,text,text,text)                                    to anon, authenticated;
grant execute on function api_add_readings(text,text,text,text,timestamptz,text,jsonb)            to anon, authenticated;
grant execute on function api_add_thickness_check(text,text,text,text,text,timestamptz,numeric,numeric[]) to anon, authenticated;
grant execute on function api_add_note(text,text,text,text,text)                                  to anon, authenticated;
grant execute on function api_add_photo(text,text,text,text,text,text,uuid)                       to anon, authenticated;
grant execute on function api_add_material_usage(text,text,text,text,text,text,numeric,numeric)   to anon, authenticated;
grant execute on function api_add_problem_report(text,text,text,text,numeric,text,timestamptz)    to anon, authenticated;
grant execute on function api_resolve_problem_report(text,uuid,text,text)                         to anon, authenticated;
grant execute on function api_start_downtime(text,text,text,text,text,text)                       to anon, authenticated;
grant execute on function api_end_downtime(text,text,text,text)                                   to anon, authenticated;
grant execute on function api_set_section_status(text,text,text,text,numeric)                     to anon, authenticated;
grant execute on function api_request_void(text,text,uuid,text,text)                              to anon, authenticated;
grant execute on function api_resolve_void(text,text,uuid,boolean)                                to anon, authenticated;
grant execute on function api_archive_work_order(text,text)                                       to anon, authenticated;
grant execute on function api_unarchive_work_order(text,text)                                     to anon, authenticated;
grant execute on function api_delete_work_order(text,text,text)                                   to anon, authenticated;

-- Verification — every api_ function the browser can now call.
select proname as api_function, pg_get_function_identity_arguments(oid) as arguments
from pg_proc where proname like 'api\_%' order by proname;
