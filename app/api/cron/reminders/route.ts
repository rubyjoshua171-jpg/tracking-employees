import { supabaseUrl } from '@/lib/supabase/config'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

type StaffRecipient = { userId: string; role: string; email: string | null; meetingEmail: boolean; contractEmail: boolean; inApp: boolean }
type Reminder = { key: string; title: string; body: string; meetingId?: string; emailSubject: string; emailHtml: string; recipients: StaffRecipient[]; emailEnabled: (recipient: StaffRecipient) => boolean }

function getServiceClient() {
  const url = supabaseUrl
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service credentials are not configured.')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

async function getGraphToken() {
  const tenant = process.env.MICROSOFT_TENANT_ID
  const clientId = process.env.MICROSOFT_CLIENT_ID
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET
  if (!tenant || !clientId || !clientSecret || !process.env.MICROSOFT_USER_ID) return null
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    cache: 'no-store',
  })
  if (!response.ok) return null
  const payload = await response.json() as { access_token?: string }
  return payload.access_token ?? null
}

async function sendGraphEmail(token: string, recipient: string, subject: string, html: string) {
  const sender = process.env.MICROSOFT_USER_ID!
  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: recipient } }] },
      saveToSentItems: true,
    }),
    cache: 'no-store',
  })
  return response.ok
}

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
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
      supabase.from('meetings').select('id,title,starts_at,teams_url').gte('starts_at', new Date(nowMs + 15 * MINUTE - 6 * MINUTE).toISOString()).lte('starts_at', new Date(nowMs + DAY + MINUTE).toISOString()),
      supabase.from('employees').select('id,name,contract_end').eq('status', 'active'),
    ])
    if (rolesResult.error || meetingsResult.error || employeesResult.error) throw new Error('Could not load reminder data.')

    const recipients: StaffRecipient[] = await Promise.all((rolesResult.data ?? []).map(async ({ user_id, role }) => {
      const [{ data: authResult }, { data: preferences }] = await Promise.all([
        supabase.auth.admin.getUserById(user_id),
        supabase.from('notification_preferences').select('meeting_email_enabled,contract_email_enabled,in_app_enabled').eq('user_id', user_id).maybeSingle(),
      ])
      return {
        userId: user_id,
        role,
        email: authResult.user?.email ?? null,
        meetingEmail: preferences?.meeting_email_enabled ?? true,
        contractEmail: preferences?.contract_email_enabled ?? true,
        inApp: preferences?.in_app_enabled ?? true,
      }
    }))

    const reminders: Reminder[] = []
    for (const meeting of meetingsResult.data ?? []) {
      const startsAt = new Date(meeting.starts_at)
      const meetingTime = startsAt.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' })
      for (const [label, offset] of [['24h', DAY], ['15m', 15 * MINUTE]] as const) {
        if (!isDue(nowMs, startsAt.getTime() - offset)) continue
        const url = meeting.teams_url ? `<p><a href="${htmlEscape(meeting.teams_url)}">Join the Teams meeting</a></p>` : ''
        reminders.push({
          key: `meeting:${meeting.id}:${label}`,
          meetingId: meeting.id,
          title: `Meeting ${label === '24h' ? 'tomorrow' : 'in 15 minutes'}: ${meeting.title}`,
          body: `${meeting.title} is scheduled for ${meetingTime}.`,
          emailSubject: `${label === '24h' ? 'Tomorrow' : 'Starting soon'}: ${meeting.title}`,
          emailHtml: `<p><strong>${htmlEscape(meeting.title)}</strong> is scheduled for ${htmlEscape(meetingTime)}.</p>${url}`,
          recipients,
          emailEnabled: (recipient) => recipient.meetingEmail,
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
        emailSubject: `Contract ending in ${daysRemaining} days: ${employee.name}`,
        emailHtml: `<p>${htmlEscape(employee.name)}'s contract ends on <strong>${htmlEscape(employee.contract_end)}</strong>.</p>`,
        recipients: adminRecipients,
        emailEnabled: (recipient) => recipient.contractEmail,
      })
    }

    const graphToken = await getGraphToken()
    let inAppCreated = 0
    let emailsSent = 0
    let emailFailures = 0

    for (const reminder of reminders) {
      for (const recipient of reminder.recipients) {
        if (recipient.inApp) {
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

        if (!graphToken || !recipient.email || !reminder.emailEnabled(recipient)) continue
        const notificationKey = `email:${reminder.key}:${recipient.userId}`
        const { error: claimError } = await supabase.from('notifications').insert({
          user_id: recipient.userId,
          meeting_id: reminder.meetingId ?? null,
          title: reminder.title,
          body: reminder.body,
          notification_key: notificationKey,
        })
        if (claimError?.code === '23505') continue
        if (claimError) throw new Error('Could not reserve an email reminder.')

        if (await sendGraphEmail(graphToken, recipient.email, reminder.emailSubject, reminder.emailHtml)) {
          emailsSent += 1
        } else {
          emailFailures += 1
          await supabase.from('notifications').delete().eq('notification_key', notificationKey)
        }
      }
    }

    return Response.json({ processed: reminders.length, inAppCreated, emailsSent, emailFailures, emailConfigured: Boolean(graphToken) })
  } catch {
    return Response.json({ error: 'Reminder processing failed.' }, { status: 500 })
  }
}
