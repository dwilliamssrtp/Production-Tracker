-- SRTP Production Tracker — authentication
-- Run after 01_schema.sql.
--
-- The login model is unchanged from the Apps Script version on purpose: an Admin signs
-- in with a username and password, operators sign in by scanning a reel tag that carries
-- a shared key. Changing how the floor signs in is a separate decision from changing the
-- database, and doing both at once would make a failure impossible to attribute.
--
-- Two things ARE better here, because they were free:
--
--   * Passwords are bcrypt (pgcrypto's crypt/gen_salt) instead of salted SHA-256.
--     SHA-256 is fast, which is exactly the wrong property for a password hash — bcrypt
--     is deliberately slow and each verification costs an attacker the same.
--     Consequence: existing password hashes cannot be carried over. The migration sets a
--     fresh admin password, shown once.
--
--   * Resolving a token is a primary-key lookup. In the Sheet it scanned every row of a
--     table that grew with every tag scan, which is why requests got slower all shift.
--
-- Every function here is SECURITY DEFINER: it runs as the table owner, so it can reach
-- tables that Row Level Security otherwise denies to everyone. That is what makes the
-- anon key safe to ship in index.html — holding it lets you *call* these functions, and
-- they decide what you are allowed to do. search_path is pinned on each one so a function
-- can't be tricked into resolving a name against someone else's schema.

-- ---------------------------------------------------------------------------
-- Internals
-- ---------------------------------------------------------------------------

-- Returns the account behind a live token, or null. Not callable from the browser.
create or replace function _session_account(p_token text)
returns accounts
language sql
stable
security definer
set search_path = public
as $$
  select a.*
  from sessions s
  join accounts a on a.id = s.account_id
  where s.token = p_token
    and s.expires_at > now()
    and a.active
$$;

revoke all on function _session_account(text) from public, anon, authenticated;

-- The single gate. Mirrors ACTION_ROLES from the Apps Script version: say which roles may
-- do a thing, and anything else is refused. Raising here means a caller gets an error, not
-- an empty result that could be mistaken for "nothing to show".
create or replace function _require(p_token text, p_roles text[])
returns accounts
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  acct accounts;
begin
  acct := _session_account(p_token);
  if acct.id is null then
    raise exception 'auth' using errcode = '28000', hint = 'session_invalid';
  end if;
  if not (acct.role = any(p_roles)) then
    raise exception 'Your login is not allowed to do that' using errcode = '42501';
  end if;
  return acct;
end;
$$;

revoke all on function _require(text, text[]) from public, anon, authenticated;

-- What the browser is allowed to know about an account. Never the hash.
create or replace function _public_account(a accounts)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'accountId', a.id,
    'username',  a.username,
    'name',      a.name,
    'role',      a.role,
    'active',    a.active
  )
$$;

-- ---------------------------------------------------------------------------
-- Sign in / out
-- ---------------------------------------------------------------------------

create or replace function api_login(p_username text, p_password text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  acct  accounts;
  tok   text;
begin
  select * into acct from accounts
   where lower(username) = lower(trim(coalesce(p_username, '')))
   limit 1;

  -- One message for "no such user" and "wrong password", so the response can't be used
  -- to work out which usernames exist. A blank hash means the account can't be signed
  -- into with a password at all — that's how the QR account stays unreachable here.
  if acct.id is null
     or not acct.active
     or coalesce(acct.password_hash, '') = ''
     or acct.password_hash <> crypt(coalesce(p_password, ''), acct.password_hash) then
    raise exception 'Invalid username or password' using errcode = '28P01';
  end if;

  delete from sessions where expires_at < now();   -- indexed; keeps the table small

  tok := encode(gen_random_bytes(24), 'hex');
  insert into sessions (token, account_id, kind, expires_at)
  values (tok, acct.id, 'password', now() + interval '30 days');

  return jsonb_build_object('token', tok, 'account', _public_account(acct));
end;
$$;

-- Trades the shop key printed into a reel tag for an operator session.
-- Short-lived on purpose: a tag is a physical credential on a shop floor, and a session
-- that outlives the shift it was started in is a session nobody is accountable for.
create or replace function api_qr_login(p_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  expected text;
  acct     accounts;
  tok      text;
begin
  select value into expected from settings where key = 'OperatorQrKey';

  if coalesce(expected, '') = '' then
    raise exception 'No operator key is configured';
  end if;
  -- Constant-time compare, so a wrong key can't be narrowed down by how long it took.
  if not (digest(coalesce(p_key, ''), 'sha256') = digest(expected, 'sha256')) then
    raise exception 'This tag is out of date — ask the controller to print a new one';
  end if;

  select * into acct from accounts where username = '(qr-scan)' and active limit 1;
  if acct.id is null then
    raise exception 'Operator account is missing — run 03_seed.sql';
  end if;

  delete from sessions where expires_at < now();

  tok := encode(gen_random_bytes(24), 'hex');
  insert into sessions (token, account_id, kind, expires_at)
  values (tok, acct.id, 'qr', now() + interval '12 hours');

  return jsonb_build_object('token', tok, 'account', _public_account(acct));
end;
$$;

create or replace function api_logout(p_token text)
returns jsonb
language sql
volatile
security definer
set search_path = public
as $$
  delete from sessions where token = p_token;
  select jsonb_build_object('ok', true);
$$;

create or replace function api_ping(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform _require(p_token, array['Admin','Operator']);
  return jsonb_build_object('ok', true, 'time', now(), 'build', 'supabase-1');
end;
$$;

-- ---------------------------------------------------------------------------
-- Password and account management
-- ---------------------------------------------------------------------------

create or replace function api_change_password(p_token text, p_old text, p_new text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  acct accounts;
  cur  accounts;
begin
  acct := _require(p_token, array['Admin','Operator']);
  select * into cur from accounts where id = acct.id;

  if coalesce(cur.password_hash, '') = '' then
    raise exception 'This login has no password to change';
  end if;
  if cur.password_hash <> crypt(coalesce(p_old, ''), cur.password_hash) then
    raise exception 'Current password is incorrect';
  end if;
  if length(coalesce(p_new, '')) < 6 then
    raise exception 'New password must be at least 6 characters';
  end if;

  update accounts set password_hash = crypt(p_new, gen_salt('bf')) where id = acct.id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_list_accounts(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform _require(p_token, array['Admin']);
  return jsonb_build_object('accounts', coalesce((
    select jsonb_agg(_public_account(a) order by a.username)
    from accounts a
    where a.username <> '(qr-scan)'
  ), '[]'::jsonb));
end;
$$;

create or replace function api_create_account(p_token text, p_username text, p_name text, p_role text, p_password text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  acct accounts;
begin
  acct := _require(p_token, array['Admin']);
  if trim(coalesce(p_username, '')) = '' then raise exception 'Username is required'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Password must be at least 6 characters'; end if;
  if p_role not in ('Admin','Operator') then raise exception 'Unknown role: %', p_role; end if;
  if exists (select 1 from accounts where lower(username) = lower(trim(p_username))) then
    raise exception 'That username is already taken';
  end if;

  insert into accounts (username, name, role, password_hash, created_by)
  values (trim(p_username), coalesce(nullif(trim(coalesce(p_name,'')), ''), trim(p_username)),
          p_role, crypt(p_password, gen_salt('bf')), acct.username);

  return api_list_accounts(p_token);
end;
$$;

-- Guards against locking everyone out of the controller side of the app.
create or replace function _assert_not_last_admin(p_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from accounts
    where role = 'Admin' and active and id <> p_id
  ) then
    raise exception 'This is the only active admin — create another admin first';
  end if;
end;
$$;

create or replace function api_update_account(p_token text, p_account_id uuid, p_name text, p_role text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  target accounts;
begin
  perform _require(p_token, array['Admin']);
  select * into target from accounts where id = p_account_id;
  if target.id is null or target.username = '(qr-scan)' then raise exception 'Unknown account'; end if;

  if p_role is not null then
    if p_role not in ('Admin','Operator') then raise exception 'Unknown role: %', p_role; end if;
    if target.role = 'Admin' and p_role <> 'Admin' then perform _assert_not_last_admin(target.id); end if;
  end if;

  update accounts
     set name = coalesce(p_name, name),
         role = coalesce(p_role, role)
   where id = p_account_id;

  -- A role change has to bite on the next request, not whenever a cache happens to lapse.
  -- There is no cache here — the role is read from the row every time — so this is simply
  -- true, which is one of the quieter wins of moving off the Sheet.
  return api_list_accounts(p_token);
end;
$$;

create or replace function api_reset_password(p_token text, p_account_id uuid, p_new text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  target accounts;
begin
  perform _require(p_token, array['Admin']);
  select * into target from accounts where id = p_account_id;
  if target.id is null or target.username = '(qr-scan)' then raise exception 'Unknown account'; end if;
  if length(coalesce(p_new, '')) < 6 then raise exception 'Password must be at least 6 characters'; end if;

  update accounts set password_hash = crypt(p_new, gen_salt('bf')) where id = p_account_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_set_account_active(p_token text, p_account_id uuid, p_active boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  target accounts;
begin
  perform _require(p_token, array['Admin']);
  select * into target from accounts where id = p_account_id;
  if target.id is null or target.username = '(qr-scan)' then raise exception 'Unknown account'; end if;
  if not p_active and target.role = 'Admin' then perform _assert_not_last_admin(target.id); end if;

  update accounts set active = p_active where id = p_account_id;
  -- Disabling someone ends their sessions immediately rather than letting them run out.
  if not p_active then delete from sessions where account_id = p_account_id; end if;
  return api_list_accounts(p_token);
end;
$$;

create or replace function api_delete_account(p_token text, p_account_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  target accounts;
begin
  perform _require(p_token, array['Admin']);
  select * into target from accounts where id = p_account_id;
  if target.id is null or target.username = '(qr-scan)' then raise exception 'Unknown account'; end if;
  if target.role = 'Admin' then perform _assert_not_last_admin(target.id); end if;

  -- Sessions cascade. Anything the person logged keeps their name on it: the work they
  -- recorded is production history and isn't theirs to take away by leaving.
  delete from accounts where id = p_account_id;
  return api_list_accounts(p_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- Operator key
-- ---------------------------------------------------------------------------

create or replace function api_get_operator_key(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform _require(p_token, array['Admin']);
  return jsonb_build_object('key', coalesce((select value from settings where key = 'OperatorQrKey'), ''));
end;
$$;

-- Invalidates every tag already printed, so they all have to be reprinted. That is the
-- deliberate cost of being able to revoke. Scanned-tag sessions are ended too, so a
-- rotation takes effect now rather than leaving up to 12 hours of access behind it.
create or replace function api_rotate_operator_key(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  new_key text;
begin
  perform _require(p_token, array['Admin']);
  new_key := encode(gen_random_bytes(16), 'hex');

  insert into settings (key, value) values ('OperatorQrKey', new_key)
  on conflict (key) do update set value = excluded.value;

  delete from sessions
   where account_id in (select id from accounts where username = '(qr-scan)');

  return jsonb_build_object('key', new_key);
end;
$$;

-- ---------------------------------------------------------------------------
-- What the browser may call
-- ---------------------------------------------------------------------------
-- Only these. Everything else — the tables, and the internal helpers above — stays out
-- of reach of the anon key that ships in the page.

grant execute on function api_login(text, text)                                  to anon, authenticated;
grant execute on function api_qr_login(text)                                     to anon, authenticated;
grant execute on function api_logout(text)                                       to anon, authenticated;
grant execute on function api_ping(text)                                         to anon, authenticated;
grant execute on function api_change_password(text, text, text)                  to anon, authenticated;
grant execute on function api_list_accounts(text)                                to anon, authenticated;
grant execute on function api_create_account(text, text, text, text, text)       to anon, authenticated;
grant execute on function api_update_account(text, uuid, text, text)             to anon, authenticated;
grant execute on function api_reset_password(text, uuid, text)                   to anon, authenticated;
grant execute on function api_set_account_active(text, uuid, boolean)            to anon, authenticated;
grant execute on function api_delete_account(text, uuid)                         to anon, authenticated;
grant execute on function api_get_operator_key(text)                             to anon, authenticated;
grant execute on function api_rotate_operator_key(text)                          to anon, authenticated;
