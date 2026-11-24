import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const searchSchema = z.object({ q: z.string().trim().min(2).max(100) })

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Sign in to search transcripts.' }, { status: 401 })

  const { data: membership } = await supabase.from('staff_roles').select('role').eq('user_id', user.id).maybeSingle()
  if (!membership || !['admin', 'manager'].includes(membership.role)) {
    return Response.json({ error: 'A workspace role is required.' }, { status: 403 })
  }

  const parsed = searchSchema.safeParse({ q: new URL(request.url).searchParams.get('q') ?? '' })
  if (!parsed.success) return Response.json({ error: 'Enter at least 2 characters to search.' }, { status: 400 })

  const pattern = `%${parsed.data.q.replace(/[\\%_]/g, '\\$&')}%`
  const { data, error } = await supabase
    .from('transcripts')
    .select('id,meeting_id,source,created_at,content')
    .ilike('content', pattern)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return Response.json({ error: 'Transcript search is unavailable.' }, { status: 500 })
  const transcripts = (data ?? []).map(({ content, ...transcript }) => {
    const query = parsed.data.q.toLowerCase()
    const matchAt = content.toLowerCase().indexOf(query)
    const start = Math.max(0, matchAt - 100)
    const end = Math.min(content.length, matchAt + query.length + 160)
    return { ...transcript, snippet: `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}` }
  })

  return Response.json({ transcripts })
}
