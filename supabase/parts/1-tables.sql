-- Lifestone CRM setup, part 1 of 3. Run the parts in order (1, 2, 3).
-- Same contents as supabase/schema.sql, split up so each run is small. Safe to run again.

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
  'approved', 'issued', 'declined', 'unreachable', 'not_interested'
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

