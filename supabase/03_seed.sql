-- SRTP Production Tracker — first run
-- Run after 02_auth.sql. Safe to re-run: it only creates what's missing.
--
-- Prints the first admin password ONCE. It's bcrypt-hashed on the way in and cannot be
-- read back out of the database, so copy it before you close the results pane.

do $$
declare
  temp_password text;
  new_key       text;
  msg           text := '';
begin
  -- The account every scanned-tag session is issued against. Its password hash is blank,
  -- and api_login refuses a blank hash, so it can never be signed into from the login box.
  if not exists (select 1 from accounts where username = '(qr-scan)') then
    insert into accounts (username, name, role, password_hash, created_by)
    values ('(qr-scan)', 'Operator (QR scan)', 'Operator', '', 'seed');
  end if;

  -- The shop key that printed reel tags carry.
  if not exists (select 1 from settings where key = 'OperatorQrKey') then
    new_key := encode(gen_random_bytes(16), 'hex');
    insert into settings (key, value) values ('OperatorQrKey', new_key);
    msg := msg || E'\nOperator QR key: ' || new_key;
  end if;

  -- First admin. Only when there is no active admin at all, so re-running this never
  -- resets a password you've already changed.
  if not exists (select 1 from accounts where role = 'Admin' and active) then
    temp_password := 'srtp-' || encode(gen_random_bytes(5), 'hex');
    insert into accounts (username, name, role, password_hash, created_by)
    values ('controller', 'Controller', 'Admin', crypt(temp_password, gen_salt('bf')), 'seed');
    msg := msg || E'\n\nFirst admin login'
               || E'\n  username: controller'
               || E'\n  password: ' || temp_password
               || E'\n\nChange it from Admin > Your password once you are in.'
               || E'\nThis is the only time it is shown — it is stored hashed.';
  end if;

  if msg = '' then
    raise notice 'Nothing to do — admin and operator key already exist.';
  else
    raise notice '%', msg;
  end if;
end;
$$;
