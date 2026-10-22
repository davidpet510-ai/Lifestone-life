-- Lifestone CRM setup, part 3 of 3. Run the parts in order (1, 2, 3).
-- Same contents as supabase/schema.sql, split up so each run is small. Safe to run again.

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
language plpgsql
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
