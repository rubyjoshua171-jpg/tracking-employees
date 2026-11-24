-- Append-only audit history for important people and pay records.
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  table_name text not null,
  record_id text not null,
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  old_data jsonb,
  new_data jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists audit_logs_occurred_at_idx on public.audit_logs(occurred_at desc);
create index if not exists audit_logs_record_idx on public.audit_logs(table_name, record_id, occurred_at desc);

alter table public.audit_logs enable row level security;
drop policy if exists "audit_logs_admin_read" on public.audit_logs;
create policy "audit_logs_admin_read" on public.audit_logs
for select to authenticated using (public.has_staff_role(array['admin']));
grant select on public.audit_logs to authenticated;

create or replace function public.capture_stafftrack_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_json jsonb;
  new_json jsonb;
  row_id text;
begin
  if tg_op = 'INSERT' then
    new_json := to_jsonb(new);
    row_id := coalesce(new_json ->> 'id', new_json ->> 'user_id');
  elsif tg_op = 'UPDATE' then
    old_json := to_jsonb(old);
    new_json := to_jsonb(new);
    row_id := coalesce(new_json ->> 'id', new_json ->> 'user_id');
  else
    old_json := to_jsonb(old);
    row_id := coalesce(old_json ->> 'id', old_json ->> 'user_id');
  end if;

  insert into public.audit_logs(actor_id, table_name, record_id, operation, old_data, new_data)
  values (auth.uid(), tg_table_name, coalesce(row_id, 'unknown'), tg_op, old_json, new_json);

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists employees_audit on public.employees;
create trigger employees_audit after insert or update or delete on public.employees
for each row execute function public.capture_stafftrack_audit();

drop trigger if exists employee_rates_audit on public.employee_rates;
create trigger employee_rates_audit after insert or update or delete on public.employee_rates
for each row execute function public.capture_stafftrack_audit();

drop trigger if exists reviews_audit on public.reviews;
create trigger reviews_audit after insert or update or delete on public.reviews
for each row execute function public.capture_stafftrack_audit();

drop trigger if exists timesheets_audit on public.timesheets;
create trigger timesheets_audit after insert or update or delete on public.timesheets
for each row execute function public.capture_stafftrack_audit();

drop trigger if exists contract_extensions_audit on public.contract_extensions;
create trigger contract_extensions_audit after insert or update or delete on public.contract_extensions
for each row execute function public.capture_stafftrack_audit();

drop trigger if exists meetings_audit on public.meetings;
create trigger meetings_audit after insert or update or delete on public.meetings
for each row execute function public.capture_stafftrack_audit();

drop trigger if exists transcripts_audit on public.transcripts;
create trigger transcripts_audit after insert or update or delete on public.transcripts
for each row execute function public.capture_stafftrack_audit();

drop trigger if exists action_items_audit on public.action_items;
create trigger action_items_audit after insert or update or delete on public.action_items
for each row execute function public.capture_stafftrack_audit();
