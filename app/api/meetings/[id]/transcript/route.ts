import { createClient } from '@/lib/supabase/server'
import { getGoogleAuthorizationUrl, getGoogleUserToken, isGoogleAuthorizationRequired } from '@/lib/google-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function googleApiUrl(path: string, params?: URLSearchParams) {
  const url = new URL(`https://meet.googleapis.com/v2/${path}`)
  if (params) url.search = params.toString()
  return url
}

async function googleGet<T>(url: URL, token: string): Promise<T | null> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
  if (!response.ok) return null
  return response.json() as Promise<T>
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Sign in to retrieve a meeting transcript.' }, { status: 401 })

  const { data: membership } = await supabase.from('staff_roles').select('role').eq('user_id', user.id).maybeSingle()
  if (!membership || !['admin', 'manager'].includes(membership.role)) return Response.json({ error: 'A workspace role is required.' }, { status: 403 })

  const { data: meeting, error } = await supabase.from('meetings').select('id,title,teams_url,created_by').eq('id', id).maybeSingle()
  if (error || !meeting) return Response.json({ error: 'Meeting not found.' }, { status: 404 })
  if (meeting.created_by !== user.id) return Response.json({ error: 'Only the person who scheduled this meeting can retrieve its Google Meet transcript.' }, { status: 403 })

  let meetingCode = ''
  try {
    const meetingUrl = new URL(meeting.teams_url ?? '')
    if (meetingUrl.protocol === 'https:' && meetingUrl.hostname === 'meet.google.com') {
      meetingCode = meetingUrl.pathname.split('/').filter(Boolean)[0] ?? ''
    }
  } catch {
    meetingCode = ''
  }
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(meetingCode)) {
    return Response.json({ error: 'This meeting does not have a Google Meet link.' }, { status: 404 })
  }

  let token: string
  try {
    token = await getGoogleUserToken(user.id)
  } catch (authorizationError) {
    if (!isGoogleAuthorizationRequired(authorizationError)) {
      return Response.json({ error: 'Google Meet could not be reached. Try again shortly.' }, { status: 503 })
    }
    try {
      const authorizationUrl = await getGoogleAuthorizationUrl(user.id, `${new URL(request.url).origin}/?googleCalendar=connected`)
      return Response.json({ error: 'Connect Google Calendar and Meet to retrieve this transcript.', authorizationUrl }, { status: 428 })
    } catch {
      return Response.json({ error: 'Google authorization is unavailable. Try again shortly.' }, { status: 503 })
    }
  }

  const recordParams = new URLSearchParams({ filter: `space.meeting_code = "${meetingCode}"` })
  const records = await googleGet<{ conferenceRecords?: Array<{ name?: string; startTime?: string }> }>(googleApiUrl('conferenceRecords', recordParams), token)
  const record = records?.conferenceRecords?.filter((item) => item.name).sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''))[0]
  if (!record?.name || !/^conferenceRecords\/[A-Za-z0-9_-]+$/.test(record.name)) {
    return Response.json({ error: 'No processed Google Meet recording transcript was found. Meet transcription must be enabled for the meeting, and processing may take a few minutes.' }, { status: 404 })
  }

  const transcripts = await googleGet<{ transcripts?: Array<{ name?: string; state?: string; startTime?: string }> }>(googleApiUrl(`${record.name}/transcripts`), token)
  const transcript = transcripts?.transcripts?.filter((item) => item.name && item.state === 'FILE_GENERATED').sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''))[0]
    ?? transcripts?.transcripts?.find((item) => item.name)
  if (!transcript?.name || !/^conferenceRecords\/[A-Za-z0-9_-]+\/transcripts\/[A-Za-z0-9_-]+$/.test(transcript.name)) {
    return Response.json({ error: 'Google Meet has not finished preparing a transcript for this meeting.' }, { status: 404 })
  }

  const entries: Array<{ text?: string; startTime?: string }> = []
  let pageToken: string | undefined
  for (let page = 0; page < 50; page += 1) {
    const params = new URLSearchParams({ pageSize: '100' })
    if (pageToken) params.set('pageToken', pageToken)
    const result = await googleGet<{ transcriptEntries?: Array<{ text?: string; startTime?: string }>; nextPageToken?: string }>(googleApiUrl(`${transcript.name}/entries`, params), token)
    if (!result) return Response.json({ error: 'Google Meet could not load transcript entries.' }, { status: 502 })
    entries.push(...(result.transcriptEntries ?? []))
    pageToken = result.nextPageToken
    if (!pageToken) break
  }

  const content = entries
    .filter((entry) => typeof entry.text === 'string' && entry.text.trim())
    .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''))
    .map((entry) => `${entry.startTime ? `[${new Date(entry.startTime).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}] ` : ''}${entry.text?.trim()}`)
    .join('\n')

  if (!content) return Response.json({ error: 'The Google Meet transcript is empty.' }, { status: 404 })
  return Response.json({ meetingTitle: meeting.title, content }, { headers: { 'Cache-Control': 'no-store' } })
}
