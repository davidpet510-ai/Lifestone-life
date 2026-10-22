-- Lifestone CRM setup, part 2 of 3. Run the parts in order (1, 2, 3).
-- Same contents as supabase/schema.sql, split up so each run is small. Safe to run again.

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

