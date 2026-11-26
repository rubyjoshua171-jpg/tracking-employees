import { supabaseUrl } from '@/lib/supabase/config'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

type StaffRecipient = { userId: string; role: string; inApp: boolean }
type Reminder = { key: string; title: string; body: string; meetingId?: string; recipients: StaffRecipient[] }

function getServiceClient() {
  const url = supabaseUrl
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service credentials are not configured.')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

function isDue(now: number, target: number) {
  return target > now - 6 * MINUTE && target <= now + MINUTE
}

function southAfricanDate(value: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value)
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getServiceClient()
    const now = new Date()
    const nowMs = now.getTime()
    const [rolesResult, meetingsResult, employeesResult] = await Promise.all([
      supabase.from('staff_roles').select('user_id,role').in('role', ['admin', 'manager']),
      supabase.from('meetings').select('id,title,starts_at').gte('starts_at', new Date(nowMs + 15 * MINUTE - 6 * MINUTE).toISOString()).lte('starts_at', new Date(nowMs + DAY + MINUTE).toISOString()),
      supabase.from('employees').select('id,name,contract_end').eq('status', 'active'),
    ])
    if (rolesResult.error || meetingsResult.error || employeesResult.error) throw new Error('Could not load reminder data.')

    const recipients: StaffRecipient[] = await Promise.all((rolesResult.data ?? []).map(async ({ user_id, role }) => {
      const { data: preferences } = await supabase.from('notification_preferences').select('in_app_enabled').eq('user_id', user_id).maybeSingle()
      return { userId: user_id, role, inApp: preferences?.in_app_enabled ?? true }
    }))

    const reminders: Reminder[] = []
    for (const meeting of meetingsResult.data ?? []) {
      const startsAt = new Date(meeting.starts_at)
      const meetingTime = startsAt.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' })
      for (const [label, offset] of [['24h', DAY], ['15m', 15 * MINUTE]] as const) {
        if (!isDue(nowMs, startsAt.getTime() - offset)) continue
        reminders.push({
          key: `meeting:${meeting.id}:${label}`,
          meetingId: meeting.id,
          title: `Meeting ${label === '24h' ? 'tomorrow' : 'in 15 minutes'}: ${meeting.title}`,
          body: `${meeting.title} is scheduled for ${meetingTime}.`,
          recipients,
        })
      }
    }

    const adminRecipients = recipients.filter((recipient) => recipient.role === 'admin')
    const today = southAfricanDate(now)
    for (const employee of employeesResult.data ?? []) {
      const endDate = new Date(`${employee.contract_end}T00:00:00.000Z`)
      const todayDate = new Date(`${today}T00:00:00.000Z`)
      const daysRemaining = Math.round((endDate.getTime() - todayDate.getTime()) / DAY)
      if (![90, 60, 30].includes(daysRemaining)) continue
      reminders.push({
        key: `contract:${employee.id}:${daysRemaining}:${employee.contract_end}`,
        title: `Contract ending in ${daysRemaining} days: ${employee.name}`,
        body: `${employee.name}'s contract ends on ${employee.contract_end}.`,
        recipients: adminRecipients,
      })
    }

    let inAppCreated = 0
    for (const reminder of reminders) {
      for (const recipient of reminder.recipients) {
        if (!recipient.inApp) continue
        const { error } = await supabase.from('notifications').insert({
          user_id: recipient.userId,
          meeting_id: reminder.meetingId ?? null,
          title: reminder.title,
          body: reminder.body,
          notification_key: `inapp:${reminder.key}:${recipient.userId}`,
        })
        if (!error) inAppCreated += 1
        else if (error.code !== '23505') throw new Error('Could not create an in-app reminder.')
      }
    }

    return Response.json({ processed: reminders.length, inAppCreated })
  } catch {
    return Response.json({ error: 'Reminder processing failed.' }, { status: 500 })
  }
}
