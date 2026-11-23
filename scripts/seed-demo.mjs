import { createClient } from '@supabase/supabase-js'

if (process.env.NODE_ENV === 'production' || process.env.STAFFTRACK_SEED_ALLOW !== 'true') {
  throw new Error('Demo seeding is blocked. Use a non-production database and explicitly set STAFFTRACK_SEED_ALLOW=true.')
}

const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STAFFTRACK_SEED_ADMIN_ID } = process.env
if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !STAFFTRACK_SEED_ADMIN_ID) {
  throw new Error('Set Supabase URL, service role key, and STAFFTRACK_SEED_ADMIN_ID in the local environment. Never put these in browser code.')
}

const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const today = new Date().toISOString().slice(0, 10)
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const employees = [
  { id: 'be7d5616-6be3-4f7e-9ed7-4d3f52582d11', name: 'Ayesha Naidoo', email: 'stafftrack-demo-ayesha@example.invalid', phone: '+27 82 555 0101', job_title: 'Operations Coordinator', department: 'Operations', contract_start: day(-100), contract_end: day(90), status: 'active', currency: 'ZAR' },
  { id: '2c327078-37f3-4537-9b4f-c1af6fe5316f', name: 'Lebo Maseko', email: 'stafftrack-demo-lebo@example.invalid', phone: '+27 82 555 0102', job_title: 'Customer Support Specialist', department: 'Customer Success', contract_start: day(-180), contract_end: day(180), status: 'active', currency: 'ZAR' },
]

for (const [table, rows] of [
  ['employees', employees],
  ['employee_rates', employees.map((employee, index) => ({ id: index ? 'f41323c7-537f-4c2a-9e5b-920846a0b142' : '010e91cc-04b7-45bf-84a7-84375b2b4524', employee_id: employee.id, hourly_rate: index ? 185 : 220, effective_from: employee.contract_start, created_by: STAFFTRACK_SEED_ADMIN_ID }))],
  ['reviews', [
    { id: '15bbddce-68df-41a6-9dc4-2bcb2c2e8ff1', employee_id: employees[0].id, reviewer_id: STAFFTRACK_SEED_ADMIN_ID, review_date: day(-35), rating: 4, punctuality: 4, quality: 5, communication: 4, teamwork: 4, comments: 'Reliable handoffs and thoughtful process improvements.' },
    { id: '0f53fb04-424c-40a9-b834-fd04f4711d9d', employee_id: employees[0].id, reviewer_id: STAFFTRACK_SEED_ADMIN_ID, review_date: today, rating: 5, punctuality: 5, quality: 5, communication: 4, teamwork: 5, comments: 'Consistently delivers accurate work and supports the team.' },
    { id: 'c65b6583-9e7d-48c0-a726-986fc51a680d', employee_id: employees[1].id, reviewer_id: STAFFTRACK_SEED_ADMIN_ID, review_date: day(-14), rating: 4, punctuality: 4, quality: 4, communication: 5, teamwork: 4, comments: 'Clear customer communication and strong follow-through.' },
  ]],
  ['timesheets', employees.map((employee, index) => ({ id: index ? 'cdce897f-9a1b-4f52-9fe1-9d8d7f2a6d31' : '3cdbad4e-bc5c-4f0c-8d0e-2233e1f5c141', employee_id: employee.id, work_date: day(-1), hours: 7.5 + index * 0.5, notes: 'Demo shift entry', created_by: STAFFTRACK_SEED_ADMIN_ID }))],
]) {
  const { error } = await supabase.from(table).upsert(rows)
  if (error) throw new Error(`Could not seed ${table}: ${error.message}`)
}

console.info('StaffTrack demo data added. No existing records were deleted.')
