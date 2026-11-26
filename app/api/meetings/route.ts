import { createClient } from '@/lib/supabase/server'
import { getGoogleAuthorizationUrl, getGoogleUserToken, isGoogleAuthorizationRequired } from '@/lib/google-connect'
import { z } from 'zod'

export const runtime = 'nodejs'

const meetingSchema = z.object({
  title: z.string().trim().min(2).max(180),
  startsAt: z.string().datetime(),
  durationMinutes: z.number().int().min(5).max(480),
  agenda: z.string().max(8000).default(''),
  attendees: z.array(z.string().trim().email().max(254)).max(100).default([]),
})

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Sign in to schedule a meeting.' }, { status: 401 })

  const { data: membership } = await supabase.from('staff_roles').select('role').eq('user_id', user.id).maybeSingle()
  if (!membership || !['admin', 'manager'].includes(membership.role)) return Response.json({ error: 'A workspace role is required.' }, { status: 403 })

  const parsed = meetingSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'Check the meeting details and attendee email addresses.' }, { status: 400 })
  const input = parsed.data
  const startsAt = new Date(input.startsAt)
  if (startsAt.getTime() <= Date.now()) return Response.json({ error: 'Choose a future meeting time.' }, { status: 400 })

  let accessToken: string
  try {
    accessToken = await getGoogleUserToken(user.id)
  } catch (authorizationError) {
    if (!isGoogleAuthorizationRequired(authorizationError)) {
      return Response.json({ error: 'Google Calendar is unavailable. Try again shortly.' }, { status: 503 })
    }
    try {
      const authorizationUrl = await getGoogleAuthorizationUrl(user.id, `${new URL(request.url).origin}/?googleCalendar=connected`)
      return Response.json({ error: 'Connect your Google Calendar to schedule meetings and create Meet links.', authorizationUrl }, { status: 428 })
    } catch {
      return Response.json({ error: 'Google Calendar authorization is unavailable. Try again shortly.' }, { status: 503 })
    }
  }

  const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000)
  const eventResponse = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      summary: input.title,
      description: input.agenda,
      start: { dateTime: startsAt.toISOString() },
      end: { dateTime: endsAt.toISOString() },
      attendees: input.attendees.map((email) => ({ email })),
      conferenceData: { createRequest: { requestId: crypto.randomUUID().replaceAll('-', ''), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    }),
    cache: 'no-store',
  })
  if (!eventResponse.ok) return Response.json({ error: 'Google Calendar could not create the event. Check your calendar access and try again.' }, { status: 502 })

  const event = await eventResponse.json() as { id?: string; hangoutLink?: string }
  if (!event.id) return Response.json({ error: 'Google Calendar returned no event ID. Try again.' }, { status: 502 })

  const { data: meeting, error } = await supabase.from('meetings').insert({
    title: input.title,
    starts_at: startsAt.toISOString(),
    duration_minutes: input.durationMinutes,
    agenda: input.agenda,
    attendees: input.attendees,
    teams_url: event.hangoutLink ?? null,
    calendar_event_id: event.id,
    graph_meeting_id: null,
    created_by: user.id,
  }).select('id,title,starts_at,duration_minutes,teams_url,attendees,calendar_event_id').single()

  if (error) {
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(event.id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    })
    return Response.json({ error: 'The meeting could not be saved to StaffTrack.' }, { status: 500 })
  }
  return Response.json({ meeting }, { status: 201 })
}
