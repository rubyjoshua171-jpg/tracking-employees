import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

export const runtime = 'nodejs'

const schema = z.object({
  actionIds: z.array(z.string().uuid()).min(1).max(50),
  edits: z.array(z.object({
    id: z.string().uuid(),
    title: z.string().trim().min(2).max(500),
    dueAt: z.string().datetime().nullable(),
  })).max(50),
})

async function getGraphToken() {
  const tenant = process.env.MICROSOFT_TENANT_ID
  const client = process.env.MICROSOFT_CLIENT_ID
  const secret = process.env.MICROSOFT_CLIENT_SECRET
  if (!tenant || !client || !secret || !process.env.MICROSOFT_USER_ID) return null
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client, client_secret: secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    cache: 'no-store',
  })
  if (!response.ok) return null
  const result = await response.json() as { access_token?: string }
  return result.access_token ?? null
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Sign in to approve transcript actions.' }, { status: 401 })

  const { data: membership } = await supabase.from('staff_roles').select('role').eq('user_id', user.id).maybeSingle()
  if (!membership || !['admin', 'manager'].includes(membership.role)) return Response.json({ error: 'A workspace role is required.' }, { status: 403 })

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'Select valid action items and check the edited details.' }, { status: 400 })

  const editsById = new Map(parsed.data.edits.map((edit) => [edit.id, edit]))
  const { data: actions, error: loadError } = await supabase
    .from('action_items')
    .select('id,meeting_id,title,due_at,calendar_event_id')
    .in('id', parsed.data.actionIds)
    .eq('accepted', false)

  if (loadError || !actions || actions.length !== parsed.data.actionIds.length) {
    return Response.json({ error: 'Some selected suggestions are no longer available. Refresh and try again.' }, { status: 409 })
  }

  const token = await getGraphToken()
  const organizer = process.env.MICROSOFT_USER_ID
  const results: Array<{ id: string; calendarAdded: boolean }> = []

  for (const action of actions) {
    const edit = editsById.get(action.id)
    const title = edit?.title ?? action.title
    const dueAt = edit ? edit.dueAt : action.due_at
    let calendarEventId: string | null = action.calendar_event_id

    if (dueAt && token && organizer && !calendarEventId) {
      const start = new Date(dueAt)
      if (!Number.isFinite(start.getTime())) return Response.json({ error: 'One of the suggested dates is invalid.' }, { status: 400 })
      const date = start.toISOString().slice(0, 10)
      const graphResponse = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizer)}/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: title,
          body: { contentType: 'text', content: 'Created from an approved StaffTrack meeting transcript action.' },
          start: { dateTime: `${date}T09:00:00`, timeZone: 'South Africa Standard Time' },
          end: { dateTime: `${date}T09:30:00`, timeZone: 'South Africa Standard Time' },
          isReminderOn: true,
          reminderMinutesBeforeStart: 30,
        }),
        cache: 'no-store',
      })
      if (!graphResponse.ok) return Response.json({ error: 'Microsoft Outlook could not create a calendar event. Check Graph permissions and organizer configuration. No remaining items were approved.' }, { status: 502 })
      const event = await graphResponse.json() as { id?: string }
      if (!event.id) return Response.json({ error: 'Outlook returned no event ID.' }, { status: 502 })
      calendarEventId = event.id
    }

    const { error: updateError } = await supabase.from('action_items').update({
      title,
      due_at: dueAt,
      accepted: true,
      calendar_event_id: calendarEventId,
    }).eq('id', action.id).eq('accepted', false)

    if (updateError) return Response.json({ error: 'An action could not be saved. Refresh the transcript review page.' }, { status: 500 })
    results.push({ id: action.id, calendarAdded: Boolean(calendarEventId) })
  }

  return Response.json({
    approved: results.length,
    calendarAdded: results.filter((item) => item.calendarAdded).length,
    calendarConfigured: Boolean(token && organizer),
    results,
  })
}
