-- Tower Inclination Monitoring System - Supabase authentication hardening
-- Run in Supabase SQL Editor as the project owner/postgres role.
-- Passwords MUST NOT be stored in public.profiles. They remain managed by Supabase Auth.

begin;

alter table public.profiles enable row level security;

-- Normalize existing usernames before applying the unique index.
update public.profiles
set username = lower(trim(username));

-- Ensure usernames are unique without making profile rows publicly readable.
create unique index if not exists profiles_username_lower_uidx
  on public.profiles (lower(username));

-- Client applications do not need anonymous access to profiles.
revoke all on table public.profiles from anon;
revoke all on table public.profiles from authenticated;
grant select on table public.profiles to authenticated;

-- Replace every existing profiles policy with one least-privilege policy.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
  loop
    execute format('drop policy if exists %I on public.profiles', policy_row.policyname);
  end loop;
end
$$;

create policy "Users can read own profile"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

-- Create/update the two intended application profiles linked to Auth user IDs.
insert into public.profiles (id, username, display_name, role)
values
  ('04a38267-845c-4fdb-bd89-b77099cbd05e', 'luatpham', 'Luat Pham', 'owner'),
  ('2d75316d-9d49-4f36-a88d-111a1ef56b4b', 'nguyenhien', 'Nguyen Hien', 'owner')
on conflict (id) do update
set
  username = excluded.username,
  display_name = excluded.display_name,
  role = excluded.role;

commit;
