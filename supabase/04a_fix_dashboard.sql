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

-- Verify: should return {"active": [], "recentComplete": [], "serverTime": "..."}
-- (empty arrays until there's data). Needs the smoke-test session from the README.
