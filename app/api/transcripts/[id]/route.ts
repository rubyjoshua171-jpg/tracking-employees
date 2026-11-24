import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const idSchema = z.string().uuid()

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Sign in to view transcripts.' }, { status: 401 })

  const { data: membership } = await supabase.from('staff_roles').select('role').eq('user_id', user.id).maybeSingle()
  if (!membership || !['admin', 'manager'].includes(membership.role)) {
    return Response.json({ error: 'A workspace role is required.' }, { status: 403 })
  }

  const { id } = await context.params
  if (!idSchema.safeParse(id).success) return Response.json({ error: 'Transcript not found.' }, { status: 400 })

  const { data: transcript, error } = await supabase
    .from('transcripts')
    .select('id,meeting_id,source,created_at,content')
    .eq('id', id)
    .maybeSingle()

  if (error) return Response.json({ error: 'Transcript could not be loaded.' }, { status: 500 })
  if (!transcript) return Response.json({ error: 'Transcript not found.' }, { status: 404 })
  return Response.json({ transcript })
}
