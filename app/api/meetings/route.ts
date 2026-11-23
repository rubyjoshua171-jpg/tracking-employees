import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const meetingSchema = z.object({
  title: z.string().trim().min(2).max(180),
  startsAt: z.string().datetime(),
  durationMinutes: z.number().int().min(5).max(480),
  agenda: z.string().max(8000).default(''),
  attendees: z.array(z.string().trim().email().max(254)).max(100).default([]),
  teamsUrl: z.string().url().nullable().optional(),
})

async function getGraphToken() {
  const tenantId = process.env.MICROSOFT_TENANT_ID
  const clientId = process.env.MICROSOFT_CLIENT_ID
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET
  if (!tenantId || !clientId || !clientSecret) return null
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    cache: 'no-store',
  })
  if (!response.ok) return null
  const payload = await response.json() as { access_token?: string }
  return payload.access_token ?? null
}

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

  let teamsUrl = input.teamsUrl ?? null
  let calendarEventId: string | null = null
  let graphMeetingId: string | null = null
  let accessToken: string | null = null

  if (!teamsUrl) {
    const organizerId = process.env.MICROSOFT_USER_ID
    if (!organizerId) return Response.json({ error: 'Connect Microsoft Teams or paste an existing Teams meeting link.' }, { status: 503 })
    accessToken = await getGraphToken()
    if (!accessToken) return Response.json({ error: 'Microsoft Graph is not configured or admin consent is missing.' }, { status: 503 })
    const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000)
    const graphResponse = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizerId)}/events?$select=id,onlineMeeting`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', Prefer: 'outlook.timezone="UTC"' },
      body: JSON.stringify({
        subject: input.title,
        body: { contentType: 'text', content: input.agenda },
        start: { dateTime: startsAt.toISOString(), timeZone: 'UTC' },
        end: { dateTime: endsAt.toISOString(), timeZone: 'UTC' },
        attendees: input.attendees.map((address) => ({ emailAddress: { address }, type: 'required' })),
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
      }),
      cache: 'no-store',
    })
    if (!graphResponse.ok) return Response.json({ error: 'Microsoft Graph could not create the meeting. Check the organizer, permissions, and application access policy.' }, { status: 502 })
    const event = await graphResponse.json() as { id?: string; onlineMeeting?: { joinUrl?: string } }
    if (!event.id || !event.onlineMeeting?.joinUrl) return Response.json({ error: 'Microsoft Graph created no Teams join link. Confirm Teams is enabled for the organizer.' }, { status: 502 })
    teamsUrl = event.onlineMeeting.joinUrl
    calendarEventId = event.id
    graphMeetingId = event.id
  } else {
    const parsedUrl = new URL(teamsUrl)
    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'teams.microsoft.com') return Response.json({ error: 'Use a secure teams.microsoft.com meeting URL.' }, { status: 400 })
  }

  const { data: meeting, error } = await supabase.from('meetings').insert({
    title: input.title,
    starts_at: startsAt.toISOString(),
    duration_minutes: input.durationMinutes,
    agenda: input.agenda,
    attendees: input.attendees,
    teams_url: teamsUrl,
    calendar_event_id: calendarEventId,
    graph_meeting_id: graphMeetingId,
    created_by: user.id,
  }).select('id,title,starts_at,duration_minutes,teams_url,attendees,calendar_event_id').single()

  if (error) {
    if (calendarEventId && accessToken) await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.MICROSOFT_USER_ID!)}/events/${encodeURIComponent(calendarEventId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` }, cache: 'no-store' })
    return Response.json({ error: 'The meeting could not be saved to StaffTrack.' }, { status: 500 })
  }
  return Response.json({ meeting }, { status: 201 })
}
