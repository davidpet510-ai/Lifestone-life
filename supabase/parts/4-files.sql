-- Lifestone CRM setup, part 4: files attached to leads. Run after parts 1–3. Safe to run again.
--
-- Files live in a PRIVATE storage bucket, one folder per lead: lead-files/<lead id>/<file>.
-- You can see, download and upload a lead's files only if you can see the lead.
-- Only the person who uploaded a file, or an admin, can remove it. Removed files stay
-- listed in the database as removed (removed_at) so there's a record of what happened.
-- Downloads use short-lived signed links; nothing is public.

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
