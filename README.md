# StaffTrack

A workforce operations workspace for contract employees. The current build includes Supabase email/password sign-in, role-gated employee access, employee creation, contract tracking and extensions, reviews, timesheet capture, admin-only rate/pay reporting, and meeting/transcript records.

## Stack

- Next.js App Router, React, TypeScript and CSS variables (`app/theme.css`)
- Supabase Auth and Postgres with RLS
- Pay is kept in an admin-only `employee_rates` table, separate from employee profile records
- Reminder email direction: Microsoft Graph `sendMail` (no Resend dependency)

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
5. Set production environment variables and callback URLs in the project settings. Keep service-role keys, Graph secrets and Google client secrets server-only; never expose them with a `NEXT_PUBLIC_` prefix.

## Integrations to configure before enabling those workflows

### Microsoft Teams and reminder email

Register an app in Microsoft Entra ID and configure the tenant, client ID, and client secret as server-only environment variables. Add the least-privilege Microsoft Graph permissions needed for the selected flow:

- Online meeting creation: `OnlineMeetings.ReadWrite` (delegated or application permission, depending on the chosen identity model).
- Transcript access: `OnlineMeetingTranscript.Read.All` where allowed by tenant policy and licensing.
- Calendar sync (if using Microsoft calendar): `Calendars.ReadWrite`.
- Reminder emails from the company mailbox: `Mail.Send`.

Grant tenant admin consent when the selected permission requires it. Verify that the organization's Microsoft 365 plan and Teams policies allow meeting transcription. The meeting API now creates a Teams-enabled Microsoft Graph calendar event (including attendee invitations) when `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and `MICROSOFT_USER_ID` are configured. Pasting an existing `https://teams.microsoft.com` link is the fallback. The service-principal flow needs tenant admin consent for `Calendars.ReadWrite` and the appropriate Teams application access policy on the organizer. Microsoft Graph transcript retrieval and Graph `sendMail` are not yet implemented.

### Google Calendar

Create a Google Cloud OAuth client, configure the exact deployed callback URL and permitted origins, and request the narrowest Calendar scope needed for event creation. Store client credentials server-side. Google Calendar event creation is not yet implemented. Users can download an `.ics` file from each scheduled meeting for manual import.

### Scheduled reminders

The protected `GET /api/cron/reminders` endpoint creates per-user in-app reminders for meetings 24 hours and 15 minutes ahead, and contract-expiry reminders for admins 90, 60 and 30 days ahead. It sends email through Microsoft Graph when Graph credentials are configured. The endpoint requires `Authorization: Bearer <CRON_SECRET>`. Configure a scheduler that supports the frequency you need and calls this endpoint; check your current Vercel plan's cron limits before relying on the included five-minute `vercel.json` schedule. For lower-cost deployments, Supabase Cron or an external scheduler can call the protected endpoint. Microsoft Graph email additionally requires `Mail.Send` admin consent and a configured sender. Delivery records use the notifications table's unique key to avoid duplicate reminders.

## Data and access safeguards

- `staff_roles` is the trusted role source. A missing assignment means the user cannot read team data.
- RLS is enabled on all application tables. Employees, reviews, meetings, contracts and actions require a staff role. Rates and timesheets require an admin role; notifications are scoped to their owner.
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

This is an early working foundation, not a production-complete HR system. Employee profiles, edits, and soft-ending are available; permanent deletion is intentionally not exposed so personal records and pay history are retained. Category ratings, rating-history chart, effective-dated admin pay reporting, contract tracking, manual Teams links, Graph event creation, ICS downloads, pasted/uploaded transcripts, rule-based date suggestions, and an explicit action-approval queue are implemented. Google OAuth/Calendar event sync, Graph transcript retrieval, Google Calendar OAuth/event sync, automatic Microsoft transcript retrieval, complete transcript search/detail views, and full server-side validation for every remaining write are still outstanding. Approved dated transcript actions can be published to Outlook when Graph is configured; otherwise they remain approved in StaffTrack. The demo seed script uses a service-role key and explicit safety gate; never run it against production. Do not treat external integrations as configured merely because their environment variable names appear in this checklist.
