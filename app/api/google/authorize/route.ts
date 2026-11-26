import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getGoogleAuthorizationUrl } from '@/lib/google-connect'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Sign in before connecting Google Calendar.' }, { status: 401 })

  const { data: membership } = await supabase.from('staff_roles').select('role').eq('user_id', user.id).maybeSingle()
  if (!membership || !['admin', 'manager'].includes(membership.role)) {
    return Response.json({ error: 'A workspace role is required to connect a calendar.' }, { status: 403 })
  }

  try {
    const callbackUrl = new URL('/?googleCalendar=connected', new URL(request.url).origin).toString()
    const authorizationUrl = await getGoogleAuthorizationUrl(user.id, callbackUrl)
    return NextResponse.redirect(authorizationUrl, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json({ error: 'Google Calendar authorization is unavailable. Try again shortly.' }, { status: 503 })
  }
}
