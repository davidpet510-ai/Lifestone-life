-- =====================================================================
-- Lifestone Life CRM database
--
-- Run once in Supabase: SQL Editor → New query → paste this whole file → Run.
-- Safe to run again after updates; it only adds or replaces things.
--
-- Who can see what:
--   admins  see every lead and the whole team, assign leads, manage agents
--   agents  see only the leads assigned to them
--   nobody  can read anything without two-step verification (aal2)
--
-- The website never talks to these tables directly. Leads are written by
-- the Netlify functions with the service key. The dashboard reads through
-- the rules below and changes things only through the lead_* / team_* / profile_*
-- functions at the bottom, which check permissions and record history.
--
-- Health answers are never stored here.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- tables ----------

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  phone       text not null default '',          -- for text alerts, E.164 like +19545551234
  role        text not null default 'agent' check (role in ('admin', 'agent')),
  active      boolean not null default true,
  alert_email boolean not null default true,
  alert_sms   boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.leads (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  first_name        text not null,
  last_name         text not null,
  email             text not null default '',
  phone             text not null,                 -- digits, 1 + 10 digits
  state             text not null default '',
  age               int,
  coverage          int,
  coverage_label    text not null default '',
  coverage_type     text not null default '',      -- Term / Universal life / Not sure
  goal              text not null default '',
  interest          text not null default '',
  replacing         text not null default '',      -- Yes / No / ''
  path              text not null check (path in ('digital', 'agent')),
  status            text not null default 'new',
  reason            text not null default '',      -- why it went to an agent
  source            text not null default '',
  best_time         text not null default '',
  consent_text      text not null default '',
  consent_at        timestamptz,
  consent_version   text not null default '',
  utm               jsonb not null default '{}',
  details           jsonb not null default '{}',   -- page, gclid, policy-review answers, etc.
  application       jsonb,                         -- non-health summary of an online application
  assigned_to       uuid references public.profiles (id) on delete set null,
  assigned_at       timestamptz,
  last_contacted_at timestamptz
);

-- Keep in sync with config/lead-statuses.js
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check check (status in (
  'new', 'abandoned', 'referred', 'contacted', 'quoted', 'app_submitted',
  'approved', 'issued', 'declined', 'unreachable', 'not_interested', 'bought_elsewhere', 'duplicate'
));

create index if not exists leads_created_at_idx  on public.leads (created_at desc);
create index if not exists leads_assigned_to_idx on public.leads (assigned_to);
create index if not exists leads_status_idx      on public.leads (status);

create table if not exists public.lead_events (
  id         bigint generated always as identity primary key,
  lead_id    uuid not null references public.leads (id) on delete cascade,
  created_at timestamptz not null default now(),
  actor      uuid references public.profiles (id) on delete set null,   -- null = the website / system
  kind       text not null,     -- created, status, assigned, note, contact, path, application, update
  body       text,
  meta       jsonb not null default '{}'
);
create index if not exists lead_events_lead_idx on public.lead_events (lead_id, created_at desc);

-- ---------- helpers ----------

-- True when the signed-in user finished two-step verification this session.
create or replace function public.mfa_ok() returns boolean
language sql stable set search_path = public
as $$ select coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;

-- The signed-in user's role, or null if they have no active profile.
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() and active $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(public.my_role() = 'admin', false) $$;

create or replace function public.can_see_lead(p_lead uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select public.mfa_ok() and public.my_role() is not null and exists (
    select 1 from public.leads l
    where l.id = p_lead and (public.is_admin() or l.assigned_to = auth.uid())
  )
$$;

-- ---------- row level security ----------

alter table public.profiles    enable row level security;
alter table public.leads       enable row level security;
alter table public.lead_events enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or (public.mfa_ok() and public.my_role() is not null));

drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads for select to authenticated
  using (public.mfa_ok() and public.my_role() is not null and (public.is_admin() or assigned_to = auth.uid()));

drop policy if exists lead_events_select on public.lead_events;
create policy lead_events_select on public.lead_events for select to authenticated
  using (public.can_see_lead(lead_id));

-- Read-only from the browser. All changes go through the functions below.
revoke all on public.profiles, public.leads, public.lead_events from anon;
revoke insert, update, delete, truncate on public.profiles, public.leads, public.lead_events from authenticated;
grant select on public.profiles, public.leads, public.lead_events to authenticated;

-- ---------- triggers ----------

-- Every new login gets a profile. The very first person becomes the admin;
-- everyone after that starts as an agent (an admin can promote them).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    case when exists (select 1 from public.profiles) then 'agent' else 'admin' end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public
as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();

-- ---------- dashboard actions ----------

create or replace function public.lead_set_status(p_lead uuid, p_status text) returns void
language plpgsql security definer set search_path = public
as $$
declare v_old text;
begin
  if not public.can_see_lead(p_lead) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select status into v_old from public.leads where id = p_lead for update;
  if v_old = p_status then return; end if;
  update public.leads set status = p_status where id = p_lead;   -- the check constraint rejects unknown statuses
  insert into public.lead_events (lead_id, actor, kind, meta)
  values (p_lead, auth.uid(), 'status', jsonb_build_object('from', v_old, 'to', p_status));
end $$;

create or replace function public.lead_assign(p_lead uuid, p_agent uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare v_name text;
begin
  if not (public.mfa_ok() and public.is_admin()) then raise exception 'Only admins can assign leads' using errcode = '42501'; end if;
  if not exists (select 1 from public.leads where id = p_lead) then raise exception 'Lead not found'; end if;
  if p_agent is not null then
    select coalesce(nullif(full_name, ''), email) into v_name from public.profiles where id = p_agent and active;
    if v_name is null then raise exception 'That team member is not active'; end if;
  end if;
  update public.leads
     set assigned_to = p_agent, assigned_at = case when p_agent is null then null else now() end
   where id = p_lead;
  insert into public.lead_events (lead_id, actor, kind, meta)
  values (p_lead, auth.uid(), 'assigned', jsonb_build_object('to', p_agent, 'name', coalesce(v_name, 'Unassigned')));
end $$;

create or replace function public.lead_add_note(p_lead uuid, p_body text) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.can_see_lead(p_lead) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_body is null or length(btrim(p_body)) = 0 then raise exception 'Note is empty'; end if;
  insert into public.lead_events (lead_id, actor, kind, body)
  values (p_lead, auth.uid(), 'note', left(btrim(p_body), 5000));
end $$;

-- Logged when an agent taps Call / Text / Email on a lead.
create or replace function public.lead_log_contact(p_lead uuid, p_via text) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.can_see_lead(p_lead) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_via not in ('call', 'text', 'email') then raise exception 'Unknown contact type'; end if;
  update public.leads set last_contacted_at = now() where id = p_lead;
  insert into public.lead_events (lead_id, actor, kind, meta)
  values (p_lead, auth.uid(), 'contact', jsonb_build_object('via', p_via));
end $$;

create or replace function public.team_update(p_user uuid, p_role text, p_active boolean) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not (public.mfa_ok() and public.is_admin()) then raise exception 'Only admins can manage the team' using errcode = '42501'; end if;
  if p_role not in ('admin', 'agent') then raise exception 'Unknown role'; end if;
  if p_user = auth.uid() and (p_role <> 'admin' or not p_active) then
    raise exception 'You can''t remove your own admin access. Ask another admin.';
  end if;
  update public.profiles set role = p_role, active = p_active where id = p_user;
  -- Leads of a deactivated agent go back to the unassigned pile.
  if not p_active then
    update public.leads set assigned_to = null, assigned_at = null where assigned_to = p_user;
  end if;
end $$;

create or replace function public.profile_update_me(p_full_name text, p_phone text, p_alert_email boolean, p_alert_sms boolean) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  update public.profiles
     set full_name = left(btrim(coalesce(p_full_name, '')), 120),
         phone = left(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), 16),
         alert_email = coalesce(p_alert_email, true),
         alert_sms = coalesce(p_alert_sms, false)
   where id = auth.uid();
end $$;

-- Only signed-in users can call the actions (each one checks permissions itself).
revoke execute on function
  public.lead_set_status(uuid, text), public.lead_assign(uuid, uuid), public.lead_add_note(uuid, text),
  public.lead_log_contact(uuid, text), public.team_update(uuid, text, boolean),
  public.profile_update_me(text, text, boolean, boolean)
from public, anon;
grant execute on function
  public.lead_set_status(uuid, text), public.lead_assign(uuid, uuid), public.lead_add_note(uuid, text),
  public.lead_log_contact(uuid, text), public.team_update(uuid, text, boolean),
  public.profile_update_me(text, text, boolean, boolean)
to authenticated;

-- Helpers used inside the access rules: signed-in users need them, visitors don't.
revoke execute on function public.mfa_ok(), public.my_role(), public.is_admin(), public.can_see_lead(uuid) from public, anon;
grant execute on function public.mfa_ok(), public.my_role(), public.is_admin(), public.can_see_lead(uuid) to authenticated;
-- Runs only as a trigger; nobody calls it directly.
revoke execute on function public.handle_new_user(), public.touch_updated_at() from public, anon, authenticated;

-- ---------- files attached to leads (same as parts/4-files.sql) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lead-files', 'lead-files', false, 26214400, array[
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv'
])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.lead_files (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads (id) on delete cascade,
  path        text not null unique,          -- storage path inside the lead-files bucket
  name        text not null,                 -- original file name, for display
  size        bigint not null default 0,
  mime        text not null default '',
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  removed_at  timestamptz,
  removed_by  uuid references public.profiles (id) on delete set null
);
alter table public.lead_files add column if not exists removed_at timestamptz;
alter table public.lead_files add column if not exists removed_by uuid references public.profiles (id) on delete set null;
create index if not exists lead_files_lead_idx on public.lead_files (lead_id, created_at desc);

alter table public.lead_files enable row level security;
drop policy if exists lead_files_select on public.lead_files;
create policy lead_files_select on public.lead_files for select to authenticated
  using (removed_at is null and public.can_see_lead(lead_id));
revoke all on public.lead_files from anon;
revoke insert, update, delete, truncate on public.lead_files from authenticated;
grant select on public.lead_files to authenticated;

-- The lead id from a storage path like "<lead id>/<file>", or null.
create or replace function public.lead_id_from_path(p_path text) returns uuid
language sql immutable set search_path = public
as $fn$
  select case when length(split_part(p_path, '/', 1)) = 36
               and split_part(p_path, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
              then split_part(p_path, '/', 1)::uuid end
$fn$;
revoke execute on function public.lead_id_from_path(text) from public, anon;
grant execute on function public.lead_id_from_path(text) to authenticated;

-- Storage rules for the bucket (no update rule: files are never overwritten).
drop policy if exists lead_files_read on storage.objects;
create policy lead_files_read on storage.objects for select to authenticated
  using (bucket_id = 'lead-files' and public.can_see_lead(public.lead_id_from_path(name)));

drop policy if exists lead_files_upload on storage.objects;
create policy lead_files_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'lead-files' and public.can_see_lead(public.lead_id_from_path(name)));

drop policy if exists lead_files_delete on storage.objects;
create policy lead_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'lead-files' and public.can_see_lead(public.lead_id_from_path(name))
         and (public.is_admin() or owner_id = auth.uid()::text));

-- Called by the dashboard right after a file finishes uploading.
create or replace function public.lead_file_added(p_lead uuid, p_path text, p_name text, p_size bigint, p_mime text) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.can_see_lead(p_lead) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if public.lead_id_from_path(p_path) is distinct from p_lead then raise exception 'File is not in this lead''s folder'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'lead-files' and name = p_path) then
    raise exception 'Upload not found';
  end if;
  insert into public.lead_files (lead_id, path, name, size, mime, uploaded_by)
  values (p_lead, p_path, left(btrim(coalesce(p_name, 'file')), 200), greatest(coalesce(p_size, 0), 0), left(coalesce(p_mime, ''), 120), auth.uid())
  returning id into v_id;
  insert into public.lead_events (lead_id, actor, kind, body, meta)
  values (p_lead, auth.uid(), 'file', left(btrim(coalesce(p_name, 'file')), 200), jsonb_build_object('action', 'added'));
  return v_id;
end $$;

-- Called after the file itself was removed from storage.
create or replace function public.lead_file_removed(p_file uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare f public.lead_files;
begin
  select * into f from public.lead_files where id = p_file and removed_at is null;
  if f.id is null or not public.can_see_lead(f.lead_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if not (public.is_admin() or f.uploaded_by = auth.uid()) then raise exception 'Only the uploader or an admin can remove this file' using errcode = '42501'; end if;
  update public.lead_files set removed_at = now(), removed_by = auth.uid() where id = p_file;
  insert into public.lead_events (lead_id, actor, kind, body, meta)
  values (f.lead_id, auth.uid(), 'file', f.name, jsonb_build_object('action', 'removed'));
end $$;

revoke execute on function public.lead_file_added(uuid, text, text, bigint, text), public.lead_file_removed(uuid) from public, anon;
grant execute on function public.lead_file_added(uuid, text, text, bigint, text), public.lead_file_removed(uuid) to authenticated;
