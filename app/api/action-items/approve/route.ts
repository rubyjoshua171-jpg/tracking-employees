import { createClient } from '@/lib/supabase/server'
import { getGoogleAuthorizationUrl, getGoogleUserToken, isGoogleAuthorizationRequired } from '@/lib/google-connect'
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

  for (const action of actions) {
    const edit = editsById.get(action.id)
    const dueAt = edit ? edit.dueAt : action.due_at
    if (dueAt && !Number.isFinite(new Date(dueAt).getTime())) {
      return Response.json({ error: 'One of the suggested dates is invalid.' }, { status: 400 })
    }
  }

  const needsCalendar = actions.some((action) => {
    const dueAt = editsById.get(action.id)?.dueAt ?? (editsById.has(action.id) ? null : action.due_at)
    return Boolean(dueAt && !action.calendar_event_id)
  })

  let token: string | null = null
  if (needsCalendar) {
    try {
      token = await getGoogleUserToken(user.id)
    } catch (authorizationError) {
      if (!isGoogleAuthorizationRequired(authorizationError)) {
        return Response.json({ error: 'Google Calendar is unavailable. No actions were approved.' }, { status: 503 })
      }
      try {
        const authorizationUrl = await getGoogleAuthorizationUrl(user.id, `${new URL(request.url).origin}/?googleCalendar=connected`)
        return Response.json({ error: 'Connect Google Calendar before approving dated actions. No actions were approved.', authorizationUrl }, { status: 428 })
      } catch {
        return Response.json({ error: 'Google Calendar authorization is unavailable. No actions were approved.' }, { status: 503 })
      }
    }
  }

  const results: Array<{ id: string; calendarAdded: boolean }> = []
  for (const action of actions) {
    const edit = editsById.get(action.id)
    const title = edit?.title ?? action.title
    const dueAt = edit ? edit.dueAt : action.due_at
    let calendarEventId: string | null = action.calendar_event_id

    if (dueAt && token && !calendarEventId) {
      const date = new Date(dueAt).toISOString().slice(0, 10)
      const eventResponse = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          summary: title,
          description: 'Created from an approved StaffTrack meeting transcript action.',
          start: { dateTime: `${date}T09:00:00`, timeZone: 'Africa/Johannesburg' },
          end: { dateTime: `${date}T09:30:00`, timeZone: 'Africa/Johannesburg' },
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
        }),
        cache: 'no-store',
      })
      if (!eventResponse.ok) return Response.json({ error: 'Google Calendar could not create an action event. No remaining items were approved.' }, { status: 502 })
      const event = await eventResponse.json() as { id?: string }
      if (!event.id) return Response.json({ error: 'Google Calendar returned no event ID.' }, { status: 502 })
      calendarEventId = event.id
    }

    const { error: updateError } = await supabase.from('action_items').update({
      title,
      due_at: dueAt,
      accepted: true,
      calendar_event_id: calendarEventId,
    }).eq('id', action.id).eq('accepted', false)

    if (updateError) {
      if (calendarEventId && token && !action.calendar_event_id) {
        await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(calendarEventId)}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
      }
      return Response.json({ error: 'An action could not be saved. Refresh the transcript review page.' }, { status: 500 })
    }
    results.push({ id: action.id, calendarAdded: Boolean(calendarEventId) })
  }

  return Response.json({
    approved: results.length,
    calendarAdded: results.filter((item) => item.calendarAdded).length,
    calendarConfigured: Boolean(token),
    results,
  })
}
