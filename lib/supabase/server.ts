import { createServerClient } from '@supabase/ssr'
import { supabaseUrl, supabaseAnonKey } from './config'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookieOptions: { secure: process.env.NODE_ENV === 'production' },
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch {
            // Server Components cannot mutate cookies; the callback Route Handler can.
          }
        },
      },
    },
  )
}
