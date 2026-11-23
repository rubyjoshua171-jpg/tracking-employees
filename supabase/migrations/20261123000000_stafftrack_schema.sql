-- StaffTrack initial database schema
-- Apply with: supabase db push (or paste into the Supabase SQL editor).
-- This migration creates the tables and access rules used by the application.

create extension if not exists pgcrypto;

create table if not exists public.staff_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'manager')),
  created_at timestamptz not null default now()
);

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 160),
  email text not null,
  phone text,
  job_title text not null,
  department text not null,
  contract_start date not null,
  contract_end date not null,
  status text not null default 'active' check (status in ('active', 'ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employees_contract_dates check (contract_end >= contract_start)
);

create table if not exists public.employee_rates (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  hourly_rate numeric(12,2) not null check (hourly_rate >= 0),
  effective_from date not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  rating integer not null check (rating between 1 and 5),
  review_date date not null,
  comments text not null default '',
  punctuality integer not null check (punctuality between 1 and 5),
  quality integer not null check (quality between 1 and 5),
  communication integer not null check (communication between 1 and 5),
  teamwork integer not null check (teamwork between 1 and 5),
  reviewer_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  starts_at timestamptz not null,
  duration_minutes integer not null check (duration_minutes between 5 and 480),
  agenda text not null default '',
  attendees jsonb not null default '[]'::jsonb,
  teams_url text,
  calendar_event_id text,
  graph_meeting_id text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.transcripts (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  content text not null check (length(content) between 20 and 200000),
  source text not null default 'pasted' check (source in ('pasted', 'upload')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.action_items (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  transcript_id uuid references public.transcripts(id) on delete set null,
  title text not null,
  due_at timestamptz,
  accepted boolean not null default false,
  calendar_event_id text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.timesheets (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  work_date date not null,
  hours numeric(5,2) not null check (hours > 0 and hours <= 24),
  notes text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.contract_extensions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  old_end_date date not null,
  new_end_date date not null,
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint contract_extension_dates check (new_end_date > old_end_date)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  meeting_id uuid references public.meetings(id) on delete cascade,
  title text not null,
  body text not null default '',
  notification_key text unique,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  meeting_email_enabled boolean not null default true,
  in_app_enabled boolean not null default true,
  contract_email_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists employees_contract_end_idx on public.employees(status, contract_end);
create index if not exists reviews_employee_date_idx on public.reviews(employee_id, review_date desc);
create index if not exists meetings_starts_at_idx on public.meetings(starts_at);
create index if not exists action_items_pending_idx on public.action_items(accepted, due_at);
create index if not exists timesheets_employee_date_idx on public.timesheets(employee_id, work_date);
create index if not exists employee_rates_effective_idx on public.employee_rates(employee_id, effective_from desc);
create index if not exists notifications_user_created_idx on public.notifications(user_id, created_at desc);

create or replace function public.has_staff_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff_roles
    where user_id = auth.uid()
      and role = any(allowed_roles)
  );
$$;

create or replace function public.validate_timesheet_contract_period()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  contract_start date;
  contract_end date;
begin
  select e.contract_start, e.contract_end
    into contract_start, contract_end
  from public.employees e
  where e.id = new.employee_id;

  if contract_start is null then
    raise exception 'Employee does not exist.';
  end if;

  if new.work_date < contract_start or new.work_date > contract_end then
    raise exception 'Timesheet date must fall within the employee contract period.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_timesheet_contract_period on public.timesheets;
create trigger validate_timesheet_contract_period
before insert or update of employee_id, work_date on public.timesheets
for each row execute function public.validate_timesheet_contract_period();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists employees_set_updated_at on public.employees;
create trigger employees_set_updated_at before update on public.employees
for each row execute function public.set_updated_at();

alter table public.staff_roles enable row level security;
alter table public.employees enable row level security;
alter table public.employee_rates enable row level security;
alter table public.reviews enable row level security;
alter table public.meetings enable row level security;
alter table public.transcripts enable row level security;
alter table public.action_items enable row level security;
alter table public.timesheets enable row level security;
alter table public.contract_extensions enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;

drop policy if exists "staff_roles_read_self_or_admin" on public.staff_roles;
create policy "staff_roles_read_self_or_admin" on public.staff_roles
for select to authenticated
using (user_id = auth.uid() or public.has_staff_role(array['admin']));

drop policy if exists "employees_staff_read" on public.employees;
create policy "employees_staff_read" on public.employees
for select to authenticated using (public.has_staff_role(array['admin', 'manager']));
drop policy if exists "employees_staff_insert" on public.employees;
create policy "employees_staff_insert" on public.employees
for insert to authenticated with check (public.has_staff_role(array['admin', 'manager']));
drop policy if exists "employees_staff_update" on public.employees;
create policy "employees_staff_update" on public.employees
for update to authenticated using (public.has_staff_role(array['admin', 'manager']))
with check (public.has_staff_role(array['admin', 'manager']));

drop policy if exists "employee_rates_admin_all" on public.employee_rates;
create policy "employee_rates_admin_all" on public.employee_rates
for all to authenticated using (public.has_staff_role(array['admin']))
with check (public.has_staff_role(array['admin']));

drop policy if exists "reviews_staff_read" on public.reviews;
create policy "reviews_staff_read" on public.reviews
for select to authenticated using (public.has_staff_role(array['admin', 'manager']));
drop policy if exists "reviews_staff_insert" on public.reviews;
create policy "reviews_staff_insert" on public.reviews
for insert to authenticated with check (public.has_staff_role(array['admin', 'manager']));
drop policy if exists "reviews_staff_update" on public.reviews;
create policy "reviews_staff_update" on public.reviews
for update to authenticated using (public.has_staff_role(array['admin', 'manager']))
with check (public.has_staff_role(array['admin', 'manager']));

drop policy if exists "meetings_staff_read" on public.meetings;
create policy "meetings_staff_read" on public.meetings
for select to authenticated using (public.has_staff_role(array['admin', 'manager']));
drop policy if exists "meetings_staff_insert" on public.meetings;
create policy "meetings_staff_insert" on public.meetings
for insert to authenticated with check (public.has_staff_role(array['admin', 'manager']));
drop policy if exists "meetings_staff_update" on public.meetings;
create policy "meetings_staff_update" on public.meetings
for update to authenticated using (public.has_staff_role(array['admin', 'manager']))
with check (public.has_staff_role(array['admin', 'manager']));

drop policy if exists "transcripts_staff_read" on public.transcripts;
create policy "transcripts_staff_read" on public.transcripts
for select to authenticated using (public.has_staff_role(array['admin', 'manager']));
drop policy if exists "transcripts_staff_insert" on public.transcripts;
create policy "transcripts_staff_insert" on public.transcripts
for insert to authenticated with check (public.has_staff_role(array['admin', 'manager']));

drop policy if exists "action_items_staff_read" on public.action_items;
create policy "action_items_staff_read" on public.action_items
for select to authenticated using (public.has_staff_role(array['admin', 'manager']));
drop policy if exists "action_items_staff_insert" on public.action_items;
create policy "action_items_staff_insert" on public.action_items
for insert to authenticated with check (public.has_staff_role(array['admin', 'manager']));
drop policy if exists "action_items_staff_update" on public.action_items;
create policy "action_items_staff_update" on public.action_items
for update to authenticated using (public.has_staff_role(array['admin', 'manager']))
with check (public.has_staff_role(array['admin', 'manager']));

drop policy if exists "timesheets_staff_read" on public.timesheets;
create policy "timesheets_staff_read" on public.timesheets
for select to authenticated using (public.has_staff_role(array['admin', 'manager']));
drop policy if exists "timesheets_staff_insert" on public.timesheets;
create policy "timesheets_staff_insert" on public.timesheets
for insert to authenticated with check (public.has_staff_role(array['admin', 'manager']));

drop policy if exists "contract_extensions_staff_read" on public.contract_extensions;
create policy "contract_extensions_staff_read" on public.contract_extensions
for select to authenticated using (public.has_staff_role(array['admin', 'manager']));
drop policy if exists "contract_extensions_staff_insert" on public.contract_extensions;
create policy "contract_extensions_staff_insert" on public.contract_extensions
for insert to authenticated with check (public.has_staff_role(array['admin', 'manager']));

drop policy if exists "notifications_owner_read" on public.notifications;
create policy "notifications_owner_read" on public.notifications
for select to authenticated using (user_id = auth.uid());
drop policy if exists "notifications_owner_update" on public.notifications;
create policy "notifications_owner_update" on public.notifications
for update to authenticated using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "notification_preferences_owner_all" on public.notification_preferences;
create policy "notification_preferences_owner_all" on public.notification_preferences
for all to authenticated using (user_id = auth.uid())
with check (user_id = auth.uid());

grant usage on schema public to authenticated;
grant select on public.staff_roles, public.employees, public.employee_rates, public.reviews,
  public.meetings, public.transcripts, public.action_items, public.timesheets,
  public.contract_extensions, public.notifications, public.notification_preferences to authenticated;
grant insert, update on public.employees, public.reviews, public.meetings,
  public.transcripts, public.action_items, public.timesheets, public.contract_extensions,
  public.notifications, public.notification_preferences to authenticated;
grant insert, update on public.employee_rates to authenticated;
