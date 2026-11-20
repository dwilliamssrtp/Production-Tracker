-- SRTP Production Tracker — saved reference recipes
-- Applied to the LIVE project mkgbaprutwznmvegpqak on 2026-11-20.
--
-- NOTE ON THIS DIRECTORY: the migration files do not reproduce the live database on their
-- own (see the backend-merge notes — 10_historical_entry.sql only describes some changes
-- in comments). The live project is the source of truth. This file IS complete and can be
-- re-run as-is.
--
-- A work order carries ~78 reference fields across Baseline, Braidline and Coverline.
-- Most jobs repeat a pipe already run, or are a near-twin of one, so retyping them is both
-- slow and the easiest place in the app to introduce a quiet error. A recipe is a work
-- order's `spec` saved under a name.
--
-- It stores `spec` verbatim rather than a chosen list of columns. That is the point: spec
-- is already the single bag holding every reference field, so a recipe cannot fall behind
-- the form — add a field to the work order and recipes carry it from then on with no
-- change here.

-- Named wo_recipes, not "recipes" or "designs". This project is SHARED with the SRTP
-- Pricing Tool, which already owns a `designs` table; an ambiguous name here would be a
-- trap for whoever reads the schema next.
create table if not exists wo_recipes (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  product_code text not null default '',
  pipe_size    text not null default '',
  customer     text not null default '',
  notes        text not null default '',
  spec         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  created_by   text not null default '',
  updated_at   timestamptz not null default now(),
  updated_by   text not null default ''
);

-- Case-insensitive: "LP1050" and "lp1050" being two separate recipes is a bug, not a
-- feature, and the one that shadows the other would be found the hard way.
create unique index if not exists wo_recipes_name_idx on wo_recipes (lower(name));

alter table wo_recipes enable row level security;   -- no policies: api_ functions only

create or replace function _recipe_json(r wo_recipes)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', r.id, 'name', r.name,
    'productCode', _js(r.product_code), 'pipeSize', _js(r.pipe_size),
    'customer', _js(r.customer), 'notes', _js(r.notes),
    'spec', r.spec,
    'fieldCount', (select count(*) from jsonb_object_keys(r.spec)),
    'updatedAt', _jt(r.updated_at), 'updatedBy', _js(r.updated_by),
    'createdAt', _jt(r.created_at), 'createdBy', _js(r.created_by))
$$;

create or replace function api_list_recipes(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions
as $$
begin
  perform _require(p_token, array['Admin']);
  return jsonb_build_object('recipes', coalesce(
    (select jsonb_agg(_recipe_json(r) order by lower(r.name)) from wo_recipes r), '[]'::jsonb));
end;
$$;

create or replace function api_save_recipe(
  p_token text, p_id uuid, p_name text, p_product_code text, p_pipe_size text,
  p_customer text, p_notes text, p_spec jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  acct accounts;
  who  text;
  nm   text := trim(coalesce(p_name, ''));
  r    wo_recipes;
begin
  acct := _require(p_token, array['Admin']);
  who  := coalesce(acct.name, acct.username);
  if nm = '' then raise exception 'Give the recipe a name'; end if;

  if p_id is null then
    -- A duplicate name almost always means "I meant to update that one", so say so rather
    -- than quietly creating a second recipe that shadows the first.
    if exists (select 1 from wo_recipes where lower(name) = lower(nm)) then
      raise exception 'A recipe called "%" already exists — load it and save over it, or pick another name', nm;
    end if;
    insert into wo_recipes (name, product_code, pipe_size, customer, notes, spec, created_by, updated_by)
    values (nm, coalesce(p_product_code,''), coalesce(p_pipe_size,''), coalesce(p_customer,''),
            coalesce(p_notes,''), coalesce(p_spec,'{}'::jsonb), who, who)
    returning * into r;
  else
    if exists (select 1 from wo_recipes where lower(name) = lower(nm) and id <> p_id) then
      raise exception 'Another recipe is already called "%"', nm;
    end if;
    update wo_recipes set name = nm, product_code = coalesce(p_product_code,''),
           pipe_size = coalesce(p_pipe_size,''), customer = coalesce(p_customer,''),
           notes = coalesce(p_notes,''), spec = coalesce(p_spec,'{}'::jsonb),
           updated_at = now(), updated_by = who
     where id = p_id
     returning * into r;
    if r.id is null then raise exception 'Recipe not found'; end if;
  end if;

  return _recipe_json(r);
end;
$$;

create or replace function api_delete_recipe(p_token text, p_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare r wo_recipes;
begin
  perform _require(p_token, array['Admin']);
  delete from wo_recipes where id = p_id returning * into r;
  if r.id is null then raise exception 'Recipe not found'; end if;
  -- Deleting a recipe never touches work orders built from it: the spec is COPIED into
  -- each work order at save time, not referenced. A recipe is a starting point, not a
  -- live link, which is what makes it safe to edit or delete one mid-project.
  return jsonb_build_object('id', p_id, 'name', r.name);
end;
$$;

grant execute on function api_list_recipes(text)                                    to anon, authenticated;
grant execute on function api_save_recipe(text,uuid,text,text,text,text,text,jsonb) to anon, authenticated;
grant execute on function api_delete_recipe(text,uuid)                              to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Re-harden. REQUIRED — see 06_harden.sql.
-- ---------------------------------------------------------------------------
-- Scoped to the tracker's own functions (api_* and _*) because this project is shared
-- with the pricing tool, whose functions are not ours to re-pin.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like any (array['api\_%','\_%'])
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

-- Expect table_made 1, rls_on true, policies 0, helpers_anon_can_call 0.
select
  (select count(*) from information_schema.tables where table_name='wo_recipes') as table_made,
  (select relrowsecurity from pg_class where relname='wo_recipes')               as rls_on,
  (select count(*) from pg_policies where tablename='wo_recipes')                as policies,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like '\_%'
      and has_function_privilege('anon', p.oid,'execute'))                       as helpers_anon_can_call;

-- ---------------------------------------------------------------------------
-- Renaming a work order (added 2026-11-20)
-- ---------------------------------------------------------------------------
-- The code is the work order's identity and pipes reference it, so renaming was
-- impossible: pipes.work_order_code pointed at it with ON UPDATE NO ACTION and any
-- change failed on the foreign key. Cascading the update makes the rename atomic —
-- every reel follows in the same statement, with no window where a reel points at a
-- work order that doesn't exist.
--
-- Reel codes are independent of the work order code, so printed QR tags keep working:
-- a tag carries the reel code. The UI says so, because that is the obvious worry.
alter table pipes drop constraint if exists pipes_work_order_code_fkey;
alter table pipes add constraint pipes_work_order_code_fkey
  foreign key (work_order_code) references work_orders(code)
  on delete cascade on update cascade;

create or replace function api_rename_work_order(p_token text, p_code text, p_new_code text)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  old_code text := trim(coalesce(p_code, ''));
  new_code text := trim(coalesce(p_new_code, ''));
  n_pipes  int;
begin
  perform _require(p_token, array['Admin']);
  if new_code = '' then raise exception 'The new code cannot be blank'; end if;
  if not exists (select 1 from work_orders where code = old_code) then
    raise exception 'Work order not found: %', old_code;
  end if;
  if new_code = old_code then raise exception 'That is already the code'; end if;
  -- Case-insensitive: two work orders differing only in case would read as the same job
  -- on a printed sheet.
  if exists (select 1 from work_orders where lower(code) = lower(new_code) and code <> old_code) then
    raise exception 'A work order called "%" already exists', new_code;
  end if;

  select count(*) into n_pipes from pipes where work_order_code = old_code;
  update work_orders set code = new_code where code = old_code;   -- reels cascade

  return jsonb_build_object('from', old_code, 'to', new_code, 'reels', n_pipes);
end;
$$;

grant execute on function api_rename_work_order(text,text,text) to anon, authenticated;

-- Expect cascade on both, and no orphaned reels.
select (select pg_get_constraintdef(oid) from pg_constraint
         where conname='pipes_work_order_code_fkey')                      as fk_definition,
       (select count(*) from pipes
         where work_order_code not in (select code from work_orders))     as orphaned_reels;
