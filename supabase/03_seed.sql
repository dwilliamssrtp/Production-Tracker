-- SRTP Production Tracker — first run
-- Run after 02_auth.sql. Safe to re-run: it only creates what's missing.
--
-- Deliberately a function that RETURNS a table rather than a DO block using RAISE NOTICE.
-- The Supabase SQL editor shows result rows reliably; notices it does not. A first-run
-- script whose entire job is to hand you a password that can never be recovered is the
-- worst possible place to print something you might not see.

create or replace function setup_seed()
returns table (item text, value text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  temp_password text;
  new_key       text;
begin
  -- The account every scanned-tag session is issued against. Its password hash is blank,
  -- and api_login refuses a blank hash, so it can never be signed into from the login box.
  if not exists (select 1 from accounts where username = '(qr-scan)') then
    insert into accounts (username, name, role, password_hash, created_by)
    values ('(qr-scan)', 'Operator (QR scan)', 'Operator', '', 'seed');
  end if;

  -- The shop key that printed reel tags carry.
  select s.value into new_key from settings s where s.key = 'OperatorQrKey';
  if new_key is null then
    new_key := encode(gen_random_bytes(16), 'hex');
    insert into settings (key, value) values ('OperatorQrKey', new_key);
  end if;

  -- First admin. Only when there is no active admin at all, so re-running this never
  -- resets a password you have already changed.
  if not exists (select 1 from accounts a where a.role = 'Admin' and a.active) then
    temp_password := 'srtp-' || encode(gen_random_bytes(5), 'hex');
    insert into accounts (username, name, role, password_hash, created_by)
    values ('controller', 'Controller', 'Admin', crypt(temp_password, gen_salt('bf')), 'seed');
  end if;

  return query
    select 'Admin username'::text, 'controller'::text
    union all
    select 'Admin password'::text,
           coalesce(temp_password, '(unchanged — an admin already existed)')
    union all
    select 'Operator QR key'::text, new_key
    union all
    select 'Next step'::text,
           'Copy the password now — it is stored hashed and cannot be read back.'::text;
end;
$$;

-- Nobody but you should ever be able to run this.
revoke all on function setup_seed() from public, anon, authenticated;

select * from setup_seed();
