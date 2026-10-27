-- Lifestone CRM setup, part 5: agent tools. Run after parts 1–4. Safe to run again.
--
--   * more client details on a lead (birthday, city/zip, hot/warm/cold, tags, do-not-contact, attempts)
--   * tasks and appointments (follow-ups with due dates and reminders)
--   * policies (pending business: carrier, premium, status, underwriting requirements, commission)
--   * message templates for texts and emails
--   * call/text outcomes ("no answer", "left voicemail", ...)
--   * importing leads from a spreadsheet (admins)
--
-- Same rules as the rest of the CRM: the browser can only read what the person may see,
-- and every change goes through a function below that checks permissions first.
-- Never store SSNs, bank or card numbers, or health details in any of these.

-- ---------- more client details on leads ----------

alter table public.leads add column if not exists dob              date;
alter table public.leads add column if not exists city             text not null default '';
alter table public.leads add column if not exists zip              text not null default '';
alter table public.leads add column if not exists temperature      text not null default '';
alter table public.leads add column if not exists tags             text[] not null default '{}';
alter table public.leads add column if not exists do_not_contact   boolean not null default false;
alter table public.leads add column if not exists contact_attempts int not null default 0;

alter table public.leads drop constraint if exists leads_temperature_check;
alter table public.leads add constraint leads_temperature_check check (temperature in ('', 'hot', 'warm', 'cold'));
create index if not exists leads_phone_idx on public.leads (phone);

-- ---------- tasks and appointments ----------

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid references public.leads (id) on delete cascade,     -- optional: a task can stand alone
  assigned_to uuid references public.profiles (id) on delete set null,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  kind        text not null default 'call' check (kind in ('call', 'text', 'email', 'appointment', 'todo')),
  title       text not null,
  notes       text not null default '',
  due_at      timestamptz not null,
  done_at     timestamptz,
  reminded_at timestamptz,          -- when the reminder email/text went out
  removed_at  timestamptz
);
create index if not exists tasks_assigned_idx on public.tasks (assigned_to, due_at) where removed_at is null;
create index if not exists tasks_lead_idx     on public.tasks (lead_id) where removed_at is null;
create index if not exists tasks_remind_idx   on public.tasks (due_at) where done_at is null and removed_at is null and reminded_at is null;

-- ---------- policies (pending business and in force) ----------

create table if not exists public.policies (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid not null references public.leads (id) on delete cascade,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references public.profiles (id) on delete set null,
  writing_agent     uuid references public.profiles (id) on delete set null,
  carrier           text not null,
  product           text not null default '',
  policy_type       text not null default '',     -- Term, Whole life, Universal life, ...
  term_years        int,
  policy_number     text not null default '',
  face_amount       numeric(14, 2),
  modal_premium     numeric(12, 2),               -- what the client pays each payment
  payment_mode      text not null default 'monthly' check (payment_mode in ('monthly', 'quarterly', 'semiannual', 'annual', 'single')),
  annual_premium    numeric(12, 2),               -- worked out from the two above
  status            text not null default 'submitted' check (status in (
                      'submitted', 'underwriting', 'approved', 'issued', 'in_force', 'declined', 'withdrawn', 'lapsed')),
  status_changed_at timestamptz not null default now(),
  submitted_on      date,
  effective_on      date,
  issued_on         date,
  placed_on         date,
  rate_class        text not null default '',
  beneficiary       text not null default '',
  commission_pct    numeric(6, 2),                -- first-year commission, percent of annual premium
  requirements      jsonb not null default '[]',  -- [{ "label": "Paramed exam", "done": false }]
  notes             text not null default '',
  removed_at        timestamptz
);
create index if not exists policies_lead_idx   on public.policies (lead_id) where removed_at is null;
create index if not exists policies_status_idx on public.policies (status) where removed_at is null;

-- ---------- message templates ----------

create table if not exists public.templates (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,   -- null = built in
  channel    text not null check (channel in ('sms', 'email')),
  name       text not null,
  subject    text not null default '',
  body       text not null,
  shared     boolean not null default true,     -- false = only the person who made it sees it
  removed_at timestamptz
);

insert into public.templates (channel, name, subject, body)
select v.channel, v.name, v.subject, v.body
from (values
  ('sms', 'First contact', '',
   'Hi {first_name}, this is {my_name} with Lifestone Life. I got your request for a life insurance quote. Is now a good time for a quick call? You can also reach me at {my_phone}. Reply STOP to opt out.'),
  ('sms', 'Sorry I missed you', '',
   'Hi {first_name}, {my_name} from Lifestone Life. Sorry I missed you! When is a good time today or tomorrow to go over your quote? It only takes a few minutes.'),
  ('sms', 'Quote ready', '',
   'Hi {first_name}, your life insurance quote is ready. Want me to walk you through it? Call or text me at {my_phone}. - {my_name}, Lifestone Life'),
  ('sms', 'Application update', '',
   'Hi {first_name}, quick update from {my_name} at Lifestone Life: your application is moving along. I''ll let you know as soon as the carrier gets back to us.'),
  ('email', 'Your quote', 'Your life insurance quote from Lifestone Life',
   E'Hi {first_name},\n\nThanks for reaching out to Lifestone Life. I''d love to go over your options for {coverage} of coverage. It usually takes about 10 minutes.\n\nWhat time works best for a quick call? You can also reach me directly at {my_phone}.\n\nThank you,\n{my_name}\nLifestone Life'),
  ('email', 'Policy issued', 'Your policy has been issued',
   E'Hi {first_name},\n\nGreat news: your policy has been issued. Thank you for trusting our family with yours.\n\nIf you have any questions, or anything changes in your life, reach out to me anytime at {my_phone}.\n\nThank you,\n{my_name}\nLifestone Life'),
  ('email', 'Annual review', 'Time for a quick coverage check-up',
   E'Hi {first_name},\n\nIt''s been about a year, so I wanted to check in. Have there been any changes, like a new home, a new baby, or a new job? A quick review makes sure your coverage still fits your family.\n\nReply here or call me at {my_phone} to set up a time.\n\nThank you,\n{my_name}\nLifestone Life')
) as v (channel, name, subject, body)
where not exists (select 1 from public.templates t where t.created_by is null and t.name = v.name);

-- ---------- row level security ----------

alter table public.tasks     enable row level security;
alter table public.policies  enable row level security;
alter table public.templates enable row level security;

create or replace function public.can_see_task(p_task uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select public.mfa_ok() and public.my_role() is not null and exists (
    select 1 from public.tasks t
    where t.id = p_task and t.removed_at is null and (
      public.is_admin() or t.assigned_to = auth.uid() or t.created_by = auth.uid()
      or (t.lead_id is not null and public.can_see_lead(t.lead_id)))
  )
$$;

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (removed_at is null and public.mfa_ok() and public.my_role() is not null and (
    public.is_admin() or assigned_to = auth.uid() or created_by = auth.uid()
    or (lead_id is not null and public.can_see_lead(lead_id))));

drop policy if exists policies_select on public.policies;
create policy policies_select on public.policies for select to authenticated
  using (removed_at is null and public.can_see_lead(lead_id));

drop policy if exists templates_select on public.templates;
create policy templates_select on public.templates for select to authenticated
  using (removed_at is null and public.mfa_ok() and public.my_role() is not null and (shared or created_by = auth.uid()));

revoke all on public.tasks, public.policies, public.templates from anon;
revoke insert, update, delete, truncate on public.tasks, public.policies, public.templates from authenticated;
grant select on public.tasks, public.policies, public.templates to authenticated;

-- ---------- actions: client details ----------

-- Updates only the fields that are sent. Logs which fields changed (not the values).
create or replace function public.lead_update_details(p_lead uuid, p jsonb) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_phone text; v_tags text[]; v_fields text[];
begin
  if not public.can_see_lead(p_lead) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p ? 'first_name' and length(btrim(coalesce(p ->> 'first_name', ''))) = 0 then raise exception 'First name can''t be empty'; end if;
  if p ? 'last_name' and length(btrim(coalesce(p ->> 'last_name', ''))) = 0 then raise exception 'Last name can''t be empty'; end if;
  if p ? 'phone' then
    v_phone := regexp_replace(coalesce(p ->> 'phone', ''), '\D', '', 'g');
    if length(v_phone) = 10 then v_phone := '1' || v_phone; end if;
    if length(v_phone) <> 11 or left(v_phone, 1) <> '1' then raise exception 'Enter a 10-digit phone number'; end if;
  end if;
  if p ? 'email' and coalesce(p ->> 'email', '') <> '' and (p ->> 'email') !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'Enter a valid email'; end if;
  if p ? 'dob' and coalesce(p ->> 'dob', '') <> '' and ((p ->> 'dob')::date > current_date or (p ->> 'dob')::date < date '1900-01-01') then raise exception 'Check the date of birth'; end if;
  if p ? 'temperature' and coalesce(p ->> 'temperature', '') not in ('', 'hot', 'warm', 'cold') then raise exception 'Unknown temperature'; end if;
  if p ? 'tags' then
    select coalesce(array_agg(distinct t), '{}') into v_tags
      from (select left(btrim(x), 30) as t from jsonb_array_elements_text(coalesce(p -> 'tags', '[]')) as x) s
     where t <> '';
    if cardinality(v_tags) > 15 then raise exception 'Use 15 tags or fewer'; end if;
  end if;

  update public.leads set
    first_name     = case when p ? 'first_name' then left(btrim(p ->> 'first_name'), 80) else first_name end,
    last_name      = case when p ? 'last_name' then left(btrim(p ->> 'last_name'), 80) else last_name end,
    phone          = case when p ? 'phone' then v_phone else phone end,
    email          = case when p ? 'email' then left(lower(btrim(coalesce(p ->> 'email', ''))), 200) else email end,
    state          = case when p ? 'state' then left(upper(btrim(coalesce(p ->> 'state', ''))), 2) else state end,
    city           = case when p ? 'city' then left(btrim(coalesce(p ->> 'city', '')), 80) else city end,
    zip            = case when p ? 'zip' then left(regexp_replace(coalesce(p ->> 'zip', ''), '[^0-9-]', '', 'g'), 10) else zip end,
    dob            = case when p ? 'dob' then nullif(p ->> 'dob', '')::date else dob end,
    age            = case when p ? 'dob' and coalesce(p ->> 'dob', '') <> '' then extract(year from age(current_date, (p ->> 'dob')::date))::int
                          when p ? 'age' then nullif(p ->> 'age', '')::int else age end,
    best_time      = case when p ? 'best_time' then left(btrim(coalesce(p ->> 'best_time', '')), 80) else best_time end,
    coverage       = case when p ? 'coverage' then nullif(regexp_replace(coalesce(p ->> 'coverage', ''), '\D', '', 'g'), '')::int else coverage end,
    coverage_type  = case when p ? 'coverage_type' then left(btrim(coalesce(p ->> 'coverage_type', '')), 40) else coverage_type end,
    temperature    = case when p ? 'temperature' then coalesce(p ->> 'temperature', '') else temperature end,
    tags           = case when p ? 'tags' then v_tags else tags end,
    do_not_contact = case when p ? 'do_not_contact' then coalesce((p ->> 'do_not_contact')::boolean, false) else do_not_contact end
  where id = p_lead;

  select array_agg(k) into v_fields from jsonb_object_keys(p) as k
   where k in ('first_name', 'last_name', 'phone', 'email', 'state', 'city', 'zip', 'dob', 'age', 'best_time',
               'coverage', 'coverage_type', 'temperature', 'tags', 'do_not_contact');
  if v_fields is not null then
    insert into public.lead_events (lead_id, actor, kind, meta)
    values (p_lead, auth.uid(), 'update', jsonb_build_object('fields', to_jsonb(v_fields),
            'do_not_contact', case when p ? 'do_not_contact' then (p ->> 'do_not_contact')::boolean end));
  end if;
end $$;

-- Tapping Call / Text / Email also counts as an attempt.
create or replace function public.lead_log_contact(p_lead uuid, p_via text) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.can_see_lead(p_lead) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_via not in ('call', 'text', 'email') then raise exception 'Unknown contact type'; end if;
  update public.leads set last_contacted_at = now(), contact_attempts = contact_attempts + 1 where id = p_lead;
  insert into public.lead_events (lead_id, actor, kind, meta)
  values (p_lead, auth.uid(), 'contact', jsonb_build_object('via', p_via));
end $$;

-- Records how a call/text/email went. If you tapped Call in the last 2 hours and haven't
-- said how it went yet, the outcome is added to that same attempt instead of a new one.
create or replace function public.lead_log_activity(p_lead uuid, p_via text, p_outcome text, p_note text) returns void
language plpgsql security definer set search_path = public
as $$
declare v_event bigint; v_note text := nullif(left(btrim(coalesce(p_note, '')), 5000), '');
begin
  if not public.can_see_lead(p_lead) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_via not in ('call', 'text', 'email', 'meeting') then raise exception 'Unknown contact type'; end if;
  if coalesce(p_outcome, '') not in ('', 'no_answer', 'voicemail', 'spoke', 'appointment', 'bad_number', 'wrong_person', 'sent', 'replied') then
    raise exception 'Unknown outcome';
  end if;
  select id into v_event from public.lead_events
   where lead_id = p_lead and actor = auth.uid() and kind = 'contact' and meta ->> 'via' = p_via
     and not (meta ? 'outcome') and created_at > now() - interval '2 hours'
   order by created_at desc limit 1;
  if v_event is not null then
    update public.lead_events set meta = meta || jsonb_build_object('outcome', coalesce(p_outcome, '')), body = coalesce(v_note, body)
     where id = v_event;
  else
    update public.leads set last_contacted_at = now(), contact_attempts = contact_attempts + 1 where id = p_lead;
    insert into public.lead_events (lead_id, actor, kind, body, meta)
    values (p_lead, auth.uid(), 'contact', v_note, jsonb_build_object('via', p_via, 'outcome', coalesce(p_outcome, '')));
  end if;
end $$;

-- ---------- actions: tasks ----------

create or replace function public.task_save(p_id uuid, p_lead uuid, p_kind text, p_title text, p_notes text, p_due timestamptz, p_assignee uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_old public.tasks; v_who uuid := coalesce(p_assignee, auth.uid()); v_title text := left(btrim(coalesce(p_title, '')), 200);
begin
  if not public.mfa_ok() or public.my_role() is null then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_kind not in ('call', 'text', 'email', 'appointment', 'todo') then raise exception 'Unknown task type'; end if;
  if v_title = '' then raise exception 'Give the task a title'; end if;
  if p_due is null then raise exception 'Pick when it''s due'; end if;
  if not exists (select 1 from public.profiles where id = v_who and active) then raise exception 'That team member is not active'; end if;

  if p_id is null then
    if v_who <> auth.uid() and not public.is_admin() then raise exception 'Only admins can give tasks to someone else' using errcode = '42501'; end if;
    if p_lead is not null and not public.can_see_lead(p_lead) then raise exception 'Not allowed' using errcode = '42501'; end if;
    insert into public.tasks (lead_id, assigned_to, created_by, kind, title, notes, due_at)
    values (p_lead, v_who, auth.uid(), p_kind, v_title, left(btrim(coalesce(p_notes, '')), 2000), p_due)
    returning id into v_id;
    if p_lead is not null then
      insert into public.lead_events (lead_id, actor, kind, body, meta)
      values (p_lead, auth.uid(), 'task', v_title, jsonb_build_object('action', 'created', 'due', p_due, 'task_kind', p_kind));
    end if;
    return v_id;
  end if;

  if not public.can_see_task(p_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into v_old from public.tasks where id = p_id for update;
  if v_who is distinct from v_old.assigned_to and v_who <> auth.uid() and not public.is_admin() then
    raise exception 'Only admins can give tasks to someone else' using errcode = '42501';
  end if;
  update public.tasks set
    kind = p_kind, title = v_title, notes = left(btrim(coalesce(p_notes, '')), 2000), assigned_to = v_who,
    due_at = p_due, reminded_at = case when p_due <> v_old.due_at then null else reminded_at end
  where id = p_id;
  return p_id;
end $$;

create or replace function public.task_set_done(p_id uuid, p_done boolean) returns void
language plpgsql security definer set search_path = public
as $$
declare v_t public.tasks;
begin
  if not public.can_see_task(p_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into v_t from public.tasks where id = p_id for update;
  if (v_t.done_at is not null) = coalesce(p_done, false) then return; end if;
  update public.tasks set done_at = case when p_done then now() else null end where id = p_id;
  if v_t.lead_id is not null then
    insert into public.lead_events (lead_id, actor, kind, body, meta)
    values (v_t.lead_id, auth.uid(), 'task', v_t.title, jsonb_build_object('action', case when p_done then 'done' else 'reopened' end, 'task_kind', v_t.kind));
  end if;
end $$;

-- Takes a task off the list (kept in the database for the record).
create or replace function public.task_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.can_see_task(p_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  update public.tasks set removed_at = now() where id = p_id;
end $$;

-- ---------- actions: policies ----------

create or replace function public.policy_save(p_id uuid, p_lead uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid; v_old public.policies; v_lead uuid; v_status text := coalesce(nullif(p ->> 'status', ''), 'submitted');
  v_mode text := coalesce(nullif(p ->> 'payment_mode', ''), 'monthly');
  v_carrier text := left(btrim(coalesce(p ->> 'carrier', '')), 120);
  v_premium numeric := nullif(regexp_replace(coalesce(p ->> 'modal_premium', ''), '[^0-9.]', '', 'g'), '')::numeric;
  v_face numeric := nullif(regexp_replace(coalesce(p ->> 'face_amount', ''), '[^0-9.]', '', 'g'), '')::numeric;
  v_pct numeric := nullif(regexp_replace(coalesce(p ->> 'commission_pct', ''), '[^0-9.]', '', 'g'), '')::numeric;
  v_req jsonb; v_agent uuid := nullif(p ->> 'writing_agent', '')::uuid;
  v_order text[] := array['new', 'abandoned', 'referred', 'contacted', 'quoted', 'app_submitted', 'approved', 'issued'];
  v_target text; v_cur text;
begin
  if v_carrier = '' then raise exception 'Enter the carrier'; end if;
  if v_status not in ('submitted', 'underwriting', 'approved', 'issued', 'in_force', 'declined', 'withdrawn', 'lapsed') then raise exception 'Unknown policy status'; end if;
  if v_mode not in ('monthly', 'quarterly', 'semiannual', 'annual', 'single') then raise exception 'Unknown payment mode'; end if;
  if v_pct is not null and v_pct > 200 then raise exception 'Commission percent looks too high'; end if;
  if jsonb_typeof(coalesce(p -> 'requirements', '[]')) <> 'array' then raise exception 'Bad requirements list'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('label', left(btrim(r ->> 'label'), 120), 'done', coalesce((r ->> 'done')::boolean, false))), '[]')
    into v_req
    from (select r from jsonb_array_elements(coalesce(p -> 'requirements', '[]')) as r limit 30) s
   where length(btrim(coalesce(r ->> 'label', ''))) > 0;

  if p_id is null then
    v_lead := p_lead;
    if not public.can_see_lead(v_lead) then raise exception 'Not allowed' using errcode = '42501'; end if;
  else
    select * into v_old from public.policies where id = p_id and removed_at is null for update;
    if not found or not public.can_see_lead(v_old.lead_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
    v_lead := v_old.lead_id;
  end if;
  if v_agent is null then v_agent := coalesce(v_old.writing_agent, (select assigned_to from public.leads where id = v_lead), auth.uid()); end if;
  if v_agent is not null and not exists (select 1 from public.profiles where id = v_agent) then raise exception 'Unknown writing agent'; end if;

  if p_id is null then
    insert into public.policies (lead_id, created_by, writing_agent, carrier, status, submitted_on, payment_mode, requirements)
    values (v_lead, auth.uid(), v_agent, v_carrier, v_status, coalesce(nullif(p ->> 'submitted_on', '')::date, current_date), v_mode, v_req)
    returning id into v_id;
  else
    v_id := p_id;
  end if;

  update public.policies set
    updated_at        = now(),
    writing_agent     = v_agent,
    carrier           = v_carrier,
    product           = left(btrim(coalesce(p ->> 'product', '')), 120),
    policy_type       = left(btrim(coalesce(p ->> 'policy_type', '')), 40),
    term_years        = nullif(p ->> 'term_years', '')::int,
    policy_number     = left(btrim(coalesce(p ->> 'policy_number', '')), 60),
    face_amount       = v_face,
    modal_premium     = v_premium,
    payment_mode      = v_mode,
    annual_premium    = round(v_premium * case v_mode when 'monthly' then 12 when 'quarterly' then 4 when 'semiannual' then 2 else 1 end, 2),
    status            = v_status,
    status_changed_at = case when v_old.id is null or v_old.status <> v_status then now() else status_changed_at end,
    submitted_on      = coalesce(nullif(p ->> 'submitted_on', '')::date, submitted_on),
    effective_on      = nullif(p ->> 'effective_on', '')::date,
    issued_on         = case when v_status in ('issued', 'in_force') then coalesce(issued_on, current_date) else issued_on end,
    placed_on         = case when v_status = 'in_force' then coalesce(placed_on, current_date) else placed_on end,
    rate_class        = left(btrim(coalesce(p ->> 'rate_class', '')), 60),
    beneficiary       = left(btrim(coalesce(p ->> 'beneficiary', '')), 160),
    commission_pct    = v_pct,
    requirements      = v_req,
    notes             = left(btrim(coalesce(p ->> 'notes', '')), 4000)
  where id = v_id;

  if v_old.id is null or v_old.status <> v_status then
    insert into public.lead_events (lead_id, actor, kind, body, meta)
    values (v_lead, auth.uid(), 'policy', v_carrier,
            jsonb_build_object('action', case when v_old.id is null then 'added' else 'status' end, 'status', v_status, 'from', v_old.status));
  end if;

  -- Move the lead forward to match the policy (never backward).
  v_target := case v_status when 'submitted' then 'app_submitted' when 'underwriting' then 'app_submitted'
                            when 'approved' then 'approved' when 'issued' then 'issued' when 'in_force' then 'issued' end;
  if v_target is not null then
    select status into v_cur from public.leads where id = v_lead for update;
    if array_position(v_order, v_target) > coalesce(array_position(v_order, v_cur), 0) then
      update public.leads set status = v_target where id = v_lead;
      insert into public.lead_events (lead_id, actor, kind, meta)
      values (v_lead, auth.uid(), 'status', jsonb_build_object('from', v_cur, 'to', v_target, 'auto', true));
    end if;
  end if;
  return v_id;
end $$;

create or replace function public.policy_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare v_p public.policies;
begin
  select * into v_p from public.policies where id = p_id and removed_at is null;
  if not found or not public.can_see_lead(v_p.lead_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  update public.policies set removed_at = now() where id = p_id;
  insert into public.lead_events (lead_id, actor, kind, body, meta)
  values (v_p.lead_id, auth.uid(), 'policy', v_p.carrier, jsonb_build_object('action', 'removed', 'status', v_p.status));
end $$;

-- ---------- actions: message templates ----------

create or replace function public.template_save(p_id uuid, p_channel text, p_name text, p_subject text, p_body text, p_shared boolean)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_owner uuid;
begin
  if not public.mfa_ok() or public.my_role() is null then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_channel not in ('sms', 'email') then raise exception 'Pick text or email'; end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then raise exception 'Give the template a name'; end if;
  if length(btrim(coalesce(p_body, ''))) = 0 then raise exception 'Write the message'; end if;
  if p_id is null then
    insert into public.templates (created_by, channel, name, subject, body, shared)
    values (auth.uid(), p_channel, left(btrim(p_name), 80), left(btrim(coalesce(p_subject, '')), 200), left(btrim(p_body), 4000), coalesce(p_shared, true))
    returning id into v_id;
    return v_id;
  end if;
  select created_by into v_owner from public.templates where id = p_id and removed_at is null;
  if not found then raise exception 'Template not found'; end if;
  if not (public.is_admin() or v_owner is not distinct from auth.uid()) then raise exception 'Only the person who made it, or an admin, can change it' using errcode = '42501'; end if;
  update public.templates set channel = p_channel, name = left(btrim(p_name), 80), subject = left(btrim(coalesce(p_subject, '')), 200),
    body = left(btrim(p_body), 4000), shared = coalesce(p_shared, true)
  where id = p_id;
  return p_id;
end $$;

create or replace function public.template_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare v_owner uuid;
begin
  if not public.mfa_ok() or public.my_role() is null then raise exception 'Not allowed' using errcode = '42501'; end if;
  select created_by into v_owner from public.templates where id = p_id and removed_at is null;
  if not found then raise exception 'Template not found'; end if;
  if not (public.is_admin() or v_owner is not distinct from auth.uid()) then raise exception 'Only the person who made it, or an admin, can remove it' using errcode = '42501'; end if;
  update public.templates set removed_at = now() where id = p_id;
end $$;

-- ---------- actions: import leads from a spreadsheet (admins) ----------

-- p_rows: [{ first_name, last_name, phone, email, state, city, zip, dob, age, coverage, coverage_type, tags, note }]
-- Rows without a name or a valid phone are skipped, and so are phones already in the CRM when p_skip_dupes.
create or replace function public.lead_import(p_rows jsonb, p_agent uuid, p_skip_dupes boolean) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb; v_phone text; v_id uuid; v_added int := 0; v_dupes int := 0; v_bad int := 0; v_dob date; v_note text; v_tags text[];
begin
  if not (public.mfa_ok() and public.is_admin()) then raise exception 'Only admins can import leads' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Nothing to import'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Import up to 2,000 rows at a time'; end if;
  if p_agent is not null and not exists (select 1 from public.profiles where id = p_agent and active) then raise exception 'That team member is not active'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_phone := regexp_replace(coalesce(r ->> 'phone', ''), '\D', '', 'g');
    if length(v_phone) = 10 then v_phone := '1' || v_phone; end if;
    if length(btrim(coalesce(r ->> 'first_name', ''))) = 0 or length(v_phone) <> 11 or left(v_phone, 1) <> '1' then
      v_bad := v_bad + 1; continue;
    end if;
    if coalesce(p_skip_dupes, true) and exists (select 1 from public.leads where phone = v_phone) then
      v_dupes := v_dupes + 1; continue;
    end if;
    begin v_dob := nullif(r ->> 'dob', '')::date; exception when others then v_dob := null; end;
    select coalesce(array_agg(distinct left(btrim(x), 30)) filter (where btrim(x) <> ''), '{}') into v_tags
      from jsonb_array_elements_text(case when jsonb_typeof(r -> 'tags') = 'array' then r -> 'tags' else '[]' end) as x;

    insert into public.leads (first_name, last_name, phone, email, state, city, zip, dob, age, coverage, coverage_type,
                              path, status, source, tags, assigned_to, assigned_at, details)
    values (left(btrim(r ->> 'first_name'), 80), left(btrim(coalesce(r ->> 'last_name', '')), 80), v_phone,
            left(lower(btrim(coalesce(r ->> 'email', ''))), 200), left(upper(btrim(coalesce(r ->> 'state', ''))), 2),
            left(btrim(coalesce(r ->> 'city', '')), 80), left(regexp_replace(coalesce(r ->> 'zip', ''), '[^0-9-]', '', 'g'), 10),
            v_dob,
            coalesce(case when v_dob is not null then extract(year from age(current_date, v_dob))::int end,
                     nullif(regexp_replace(coalesce(r ->> 'age', ''), '\D', '', 'g'), '')::int),
            nullif(regexp_replace(coalesce(r ->> 'coverage', ''), '\D', '', 'g'), '')::int,
            left(btrim(coalesce(r ->> 'coverage_type', '')), 40),
            'agent', 'new', 'import', v_tags, p_agent, case when p_agent is null then null else now() end,
            jsonb_build_object('imported_by', auth.uid()))
    returning id into v_id;
    insert into public.lead_events (lead_id, actor, kind, meta)
    values (v_id, auth.uid(), 'created', jsonb_build_object('source', 'import', 'path', 'agent'));
    v_note := nullif(left(btrim(coalesce(r ->> 'note', '')), 5000), '');
    if v_note is not null then
      insert into public.lead_events (lead_id, actor, kind, body) values (v_id, auth.uid(), 'note', v_note);
    end if;
    v_added := v_added + 1;
  end loop;
  return jsonb_build_object('added', v_added, 'duplicates', v_dupes, 'skipped', v_bad);
end $$;

-- ---------- who can call what ----------

revoke execute on function
  public.can_see_task(uuid), public.lead_update_details(uuid, jsonb), public.lead_log_activity(uuid, text, text, text),
  public.task_save(uuid, uuid, text, text, text, timestamptz, uuid), public.task_set_done(uuid, boolean), public.task_remove(uuid),
  public.policy_save(uuid, uuid, jsonb), public.policy_remove(uuid),
  public.template_save(uuid, text, text, text, text, boolean), public.template_remove(uuid),
  public.lead_import(jsonb, uuid, boolean)
from public, anon;
grant execute on function
  public.can_see_task(uuid), public.lead_update_details(uuid, jsonb), public.lead_log_activity(uuid, text, text, text),
  public.task_save(uuid, uuid, text, text, text, timestamptz, uuid), public.task_set_done(uuid, boolean), public.task_remove(uuid),
  public.policy_save(uuid, uuid, jsonb), public.policy_remove(uuid),
  public.template_save(uuid, text, text, text, text, boolean), public.template_remove(uuid),
  public.lead_import(jsonb, uuid, boolean)
to authenticated;
