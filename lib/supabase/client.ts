import { createBrowserClient } from '@supabase/ssr'
import { supabaseUrl, supabaseAnonKey } from './config'

let browserClient: ReturnType<typeof createBrowserClient> | undefined

export function createClient() {
  browserClient ??= createBrowserClient(
    supabaseUrl,
    supabaseAnonKey,
    { cookieOptions: { secure: process.env.NODE_ENV === 'production' } },
  )
  return browserClient
}
