// Public Supabase project URL. Falls back to the StaffTrack project
// ("supabase-purple-car") when NEXT_PUBLIC_SUPABASE_URL isn't set;
// setting the env var overrides it.
export const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ubopuieoruhicitqektg.supabase.co'
export const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

// True when the anon key is available. Without it the app renders a setup notice instead of crashing.
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)
