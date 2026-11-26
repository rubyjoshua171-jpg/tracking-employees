# StaffTrack

A workforce operations workspace for contract employees. The current build includes Supabase email/password sign-in, role-gated employee access, employee creation, contract tracking and extensions, reviews, timesheet capture, admin-only rate/pay reporting, and meeting/transcript records.

## Stack

- Next.js App Router, React, TypeScript and CSS variables (`app/theme.css`)
- Supabase Auth and Postgres with RLS
- Pay is kept in an admin-only `employee_rates` table, separate from employee profile records
- Google Calendar and Meet access is authorized per signed-in staff user through the attached Vercel Connect connector

## Getting started

1. Connect the Supabase integration to this Vercel project. Its public URL and publishable/anon key are injected as `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
2. Apply the SQL migrations in `supabase/migrations/` to the connected Supabase project before using the app. They create the core tables, row-level security policies, contract-date validation and audit history. The migration files are version-controlled; creating them in GitHub does not apply them to Supabase automatically.
3. Create an account through StaffTrack. Supabase email confirmation may need to be completed before signing in.
4. Assign the first workspace admin using a trusted SQL console for the connected Supabase project, replacing the email with the account you just created:

   ```sql
   insert into public.staff_roles (user_id, role)
   select id, 'admin' from auth.users where email = 'admin@company.co.za'
   on conflict (user_id) do update set role = excluded.role;
   ```

   Add managers in the same way with the `manager` role. Role assignments are intentionally not self-service: a signed-in user cannot grant themselves admin access.
5. Set the Supabase and cron environment variables in the project settings. Admins and managers connect their own Google account from the Meetings or Transcript review page; Vercel Connect manages provider credentials, so no Google client secret is stored in the app.

## Integrations to configure before enabling those workflows

### Google Calendar and Meet

Admins and managers connect their own Google account from StaffTrack. The Vercel Connect connector requests Calendar event access and Google Meet read-only access for the signed-in user. Scheduling creates a Google Calendar event, invites attendees, and requests a Google Meet link. Dated transcript actions are added to the approving user's calendar only after explicit approval. Meet transcript retrieval is available to the user who scheduled the meeting, after Meet has generated a transcript; the organization's Google Workspace policy must permit transcription and transcript access. No Google OAuth client secret is stored in project environment variables.

### Scheduled reminders

The protected `GET /api/cron/reminders` endpoint creates per-user in-app reminders for meetings 24 hours and 15 minutes ahead, and contract-expiry reminders for admins 90, 60 and 30 days ahead. It requires `Authorization: Bearer <CRON_SECRET>`; configure the same secret in Vercel so Cron sends the expected authorization header. Vercel Cron runs on Production deployments, not Preview deployments. The included `vercel.json` schedule runs every five minutes, which is needed for timely meeting reminders and requires a Vercel plan that permits that frequency. Hobby cron jobs are limited to once per day; a daily schedule can still process contract reminders but will miss the 24-hour and 15-minute meeting reminder windows. Delivery records use the notifications table's unique key to avoid duplicate reminders.

## Data and access safeguards

- `staff_roles` is the trusted role source. A missing assignment means the user cannot read team data.
- RLS is enabled on all application tables. Employees, reviews, meetings, contracts, action items and timesheets require a staff role. Employee rates and pay reports are admin-only; managers can record work hours but cannot view pay rates or payroll totals. Notifications are scoped to their owner.
- Employee rate history is effective-dated. Pay reports sum logged hours against the rate effective on each work date. Unlogged time is not included.
- A database trigger rejects timesheet dates outside the employee's contract period. Audit triggers capture review, rate and timesheet changes.
- Managers should not receive pay-table access. Do not add broad table grants or disable RLS to work around permission errors.
- Employee data is personal information. Apply POPIA principles: collect only necessary information, limit access by role, define retention/deletion rules, secure exports and backups, document the lawful purpose, and provide appropriate notices and data-subject request handling. Obtain the company's privacy/legal review before production use.
- HTTPS and baseline security response headers are configured for deployment. Verify preview and production callback URLs and domain/TLS settings before launch.

## Demo data seed

For a non-production Supabase project only, set `STAFFTRACK_SEED_ALLOW=true`, `STAFFTRACK_SEED_ADMIN_ID` to the UUID of an existing admin account, and `SUPABASE_SERVICE_ROLE_KEY` in a secure local environment, then run `pnpm seed:demo`. The seed has stable IDs for repeatability, creates synthetic employee records and history, and never deletes data. The script refuses to run in `NODE_ENV=production`. Do not commit secrets or use the service-role key in client code.

## Tests

Run the built-in Node test suite with `pnpm test`. It covers effective-dated pay arithmetic, logged-time-only calculations, contract expiry thresholds, and transcript date extraction.

## Current implementation boundary

This is an early working foundation, not a production-complete HR system. Employee profiles, edits, and soft-ending are available; permanent deletion is intentionally not exposed so personal records and pay history are retained. Category ratings, rating-history chart, effective-dated admin pay reporting, contract tracking, Google Calendar meeting creation, Meet transcript import, ICS downloads, pasted/uploaded transcripts, rule-based date suggestions, and an explicit action-approval queue are implemented. Google Calendar authorization is per user through Vercel Connect. Transcript retrieval depends on Google Meet generating a transcript and the current user being the meeting organizer. The demo seed script uses a service-role key and explicit safety gate; never run it against production.
