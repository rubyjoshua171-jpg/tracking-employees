// True when the Supabase project URL and anon key are available.
// Without them the app renders a setup notice instead of crashing.
export const isSupabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
)
