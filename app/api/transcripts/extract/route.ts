import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { extractActionSuggestions } from '@/lib/transcript-extraction.mjs'

const transcriptSchema = z.object({
  meetingId: z.string().uuid(),
  content: z.string().trim().min(20).max(200_000),
  source: z.enum(['pasted', 'upload']).default('pasted'),
})

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Sign in to add a transcript.' }, { status: 401 })
  const { data: membership } = await supabase.from('staff_roles').select('role').eq('user_id', user.id).maybeSingle()
  if (!membership || !['admin', 'manager'].includes(membership.role)) return Response.json({ error: 'A workspace role is required.' }, { status: 403 })

  const parsed = transcriptSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'Choose a meeting and provide at least 20 characters of transcript text.' }, { status: 400 })
  const { meetingId, content, source } = parsed.data
  const { data: meeting } = await supabase.from('meetings').select('id,starts_at').eq('id', meetingId).maybeSingle()
  if (!meeting) return Response.json({ error: 'Meeting not found.' }, { status: 404 })

  const { data: transcript, error: transcriptError } = await supabase.from('transcripts').insert({ meeting_id: meetingId, content, source, created_by: user.id }).select('id,meeting_id,content,source,created_at').single()
  if (transcriptError || !transcript) return Response.json({ error: 'Transcript could not be saved.' }, { status: 500 })

  const suggestions: Array<{ title: string; due_at: string | null }> = extractActionSuggestions(content, new Date(meeting.starts_at))

  if (suggestions.length) {
    const { data: items, error: itemsError } = await supabase.from('action_items').insert(suggestions.map((item) => ({
      meeting_id: meetingId,
      transcript_id: transcript.id,
      title: item.title,
      due_at: item.due_at,
      accepted: false,
      created_by: user.id,
    }))).select('id,meeting_id,transcript_id,title,due_at,accepted,calendar_event_id,created_at')
    if (itemsError) return Response.json({ error: 'Transcript saved, but suggestions could not be created.' }, { status: 500 })
    return Response.json({ transcript, suggestions: items ?? [] }, { status: 201 })
  }
  return Response.json({ transcript, suggestions: [] }, { status: 201 })
}
