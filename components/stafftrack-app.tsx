'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { isSupabaseConfigured } from '@/lib/supabase/config'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { calculatePayForEntries, contractDaysRemaining, contractExpiryBand } from '@/lib/stafftrack-logic.mjs'
import ReviewHistoryChart from '@/components/review-history-chart'
import { Activity, Bell, CalendarDays, CalendarRange, ChevronDown, ChevronLeft, ChevronRight, Clock3, Download, LayoutDashboard, LogOut, Menu, Plus, Search, Settings2, ShieldCheck, Star, Users, WalletCards, X } from 'lucide-react'

type Employee = { id: string; name: string; email: string; phone: string | null; job_title: string; department: string; contract_start: string; contract_end: string; status: 'active' | 'ended' }
type Review = { id: string; employee_id: string; rating: number; review_date: string; comments: string; punctuality: number; quality: number; communication: number; teamwork: number }
type Meeting = { id: string; title: string; starts_at: string; duration_minutes: number; teams_url: string | null; attendees: unknown[]; agenda?: string }
type ActionItem = { id: string; meeting_id: string; title: string; due_at: string | null; accepted: boolean }
type NotificationItem = { id: string; title: string; body: string; read_at: string | null; created_at: string }
type NotificationPreferences = { meeting_email_enabled: boolean; in_app_enabled: boolean; contract_email_enabled: boolean }
type TranscriptSummary = { id: string; meeting_id: string; source: 'pasted' | 'upload'; created_at: string }
type TranscriptSearchResult = TranscriptSummary & { snippet: string }
type TranscriptDetail = TranscriptSummary & { content: string }
type Section = 'Overview' | 'Employees' | 'Reviews' | 'Timesheets & pay' | 'Contracts' | 'Meetings' | 'Transcript review'

// Only create the client when configured, so builds without Supabase keys don't crash.
const supabase = (isSupabaseConfigured ? createClient() : null) as ReturnType<typeof createClient>
const nav: { name: Section; icon: typeof LayoutDashboard }[] = [
  { name: 'Overview', icon: LayoutDashboard }, { name: 'Employees', icon: Users }, { name: 'Reviews', icon: Star },
  { name: 'Timesheets & pay', icon: WalletCards }, { name: 'Contracts', icon: CalendarRange }, { name: 'Meetings', icon: CalendarDays }, { name: 'Transcript review', icon: Activity },
]
const initials = (name: string) => name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase()
const fmtDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
const daysUntil = contractDaysRemaining
const zar = (amount: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(amount)
const icsText = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (character) => `\\${character}`)
function downloadIcs(meeting: Meeting) {
  const format = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const startsAt = new Date(meeting.starts_at)
  const endsAt = new Date(startsAt.getTime() + meeting.duration_minutes * 60_000)
  const body = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//StaffTrack//Meetings//EN','BEGIN:VEVENT',`UID:${meeting.id}@stafftrack`,`DTSTAMP:${format(new Date())}`,`DTSTART:${format(startsAt)}`,`DTEND:${format(endsAt)}`,`SUMMARY:${icsText(meeting.title)}`,`DESCRIPTION:${icsText(meeting.agenda ?? '')}`,...(meeting.teams_url ? [`URL:${icsText(meeting.teams_url)}`] : []),'END:VEVENT','END:VCALENDAR'].join('\r\n')
  const url = URL.createObjectURL(new Blob([body], { type: 'text/calendar;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${meeting.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'stafftrack-meeting'}.ics`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function StaffTrackApp() {
  if (!isSupabaseConfigured) return <SetupNotice />
  return <StaffTrackWorkspace />
}

function SetupNotice() {
  return <div className="auth-screen"><div className="auth-card"><a className="brand auth-brand" href="#"><span className="brand-mark"><Activity size={19} strokeWidth={2.5} /></span><span>staff<span className="brand-light">track</span><small>PEOPLE OPERATIONS</small></span></a><div className="auth-kicker">SETUP REQUIRED</div><h1>StaffTrack isn’t connected yet.</h1><p className="auth-intro">This workspace needs a Supabase project before sign-in and data features can work. Add <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to the site’s environment variables, then redeploy.</p></div></div>
}

function StaffTrackWorkspace() {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<'admin' | 'manager' | null>(null)
  const [section, setSection] = useState<Section>('Overview')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [reviews, setReviews] = useState<Review[]>([])
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [transcriptMeetings, setTranscriptMeetings] = useState<Meeting[]>([])
  const [transcriptRecords, setTranscriptRecords] = useState<TranscriptSummary[]>([])
  const [transcriptResults, setTranscriptResults] = useState<TranscriptSearchResult[] | null>(null)
  const [transcriptQuery, setTranscriptQuery] = useState('')
  const [selectedTranscript, setSelectedTranscript] = useState<TranscriptDetail | null>(null)
  const [transcriptDetailLoading, setTranscriptDetailLoading] = useState(false)
  const [actionItems, setActionItems] = useState<ActionItem[]>([])
  const [selectedActionIds, setSelectedActionIds] = useState<string[]>([])
  const [transcriptText, setTranscriptText] = useState('')
  const [transcriptSource, setTranscriptSource] = useState<'pasted' | 'upload'>('pasted')
  const [noticeCount, setNoticeCount] = useState(0)
  const [payEstimate, setPayEstimate] = useState<number | null>(null)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [preferences, setPreferences] = useState<NotificationPreferences>({ meeting_email_enabled: true, in_app_enabled: true, contract_email_enabled: true })
  const [savingPreferences, setSavingPreferences] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [googleAuthorizationUrl, setGoogleAuthorizationUrl] = useState('')
  const [transcriptMeetingId, setTranscriptMeetingId] = useState('')
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState<'employee' | 'meeting' | 'review' | 'timesheet' | 'transcript' | 'profile' | 'settings' | null>(null)
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null)
  const [profileEmployee, setProfileEmployee] = useState<Employee | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [filter, setFilter] = useState('all')

  const refresh = useCallback(async () => {
    const { data: { session: current } } = await supabase.auth.getSession()
    if (!current) { setSession(null); setRole(null); setEmployees([]); setLoading(false); return }
    setSession(current)
    const { data: member } = await supabase.from('staff_roles').select('role').eq('user_id', current.user.id).maybeSingle()
    setRole(member?.role ?? null)
    if (member?.role === 'admin' || member?.role === 'manager') {
      const today = new Date().toISOString().slice(0, 10)
      const { error: expiryError } = await supabase.from('employees').update({ status: 'ended' }).eq('status', 'active').lt('contract_end', today)
      if (expiryError) setError('Contract expiry status could not be refreshed. Check your workspace permissions.')
    }
    const [people, ratings, events, transcriptEvents, transcripts, pendingItems, alerts, notificationSettings] = await Promise.all([
      supabase.from('employees').select('id,name,email,phone,job_title,department,contract_start,contract_end,status').order('contract_end'),
      supabase.from('reviews').select('id,employee_id,rating,review_date,comments,punctuality,quality,communication,teamwork').order('review_date', { ascending: false }),
      supabase.from('meetings').select('id,title,starts_at,duration_minutes,teams_url,attendees,agenda').gte('starts_at', new Date().toISOString()).order('starts_at').limit(30),
      supabase.from('meetings').select('id,title,starts_at,duration_minutes,teams_url,attendees,agenda').order('starts_at', { ascending: false }).limit(50),
      supabase.from('transcripts').select('id,meeting_id,source,created_at').order('created_at', { ascending: false }).limit(50),
      supabase.from('action_items').select('id,meeting_id,title,due_at,accepted').eq('accepted', false).order('created_at', { ascending: false }).limit(100),
      supabase.from('notifications').select('id,title,body,read_at,created_at').or('notification_key.is.null,notification_key.like.inapp:%').order('created_at', { ascending: false }).limit(20),
      supabase.from('notification_preferences').select('meeting_email_enabled,in_app_enabled,contract_email_enabled').eq('user_id', current.user.id).maybeSingle(),
    ])
    if (people.error) setError(people.error.message)
    setEmployees((people.data ?? []) as Employee[])
    if (member?.role === 'admin') {
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10)
      const [hours, rates] = await Promise.all([
        supabase.from('timesheets').select('employee_id,work_date,hours').gte('work_date', monthStart).lte('work_date', monthEnd),
        supabase.from('employee_rates').select('employee_id,effective_from,hourly_rate').lte('effective_from', monthEnd),
      ])
      if (!hours.error && !rates.error) setPayEstimate(calculatePayForEntries(hours.data ?? [], rates.data ?? [], monthStart.slice(0, 7)))
      else setPayEstimate(null)
    } else setPayEstimate(null)
    setReviews((ratings.data ?? []) as Review[])
    setMeetings((events.data ?? []) as Meeting[])
    setTranscriptMeetings((transcriptEvents.data ?? []) as Meeting[])
    setTranscriptRecords((transcripts.data ?? []) as TranscriptSummary[])
    setActionItems((pendingItems.data ?? []) as ActionItem[])
    const inbox = (alerts.data ?? []) as NotificationItem[]
    setPreferences(notificationSettings.data ?? { meeting_email_enabled: true, in_app_enabled: true, contract_email_enabled: true })
    setNotifications(inbox)
    setNoticeCount(inbox.filter((item) => !item.read_at).length)
    setLoading(false)
  }, [])

  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(({ data: { session: current } }: { data: { session: Session | null } }) => {
      if (mounted) { setSession(current); if (current) void refresh(); else setLoading(false) }
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, current: Session | null) => {
      setSession(current)
      if (current) void refresh(); else { setRole(null); setLoading(false) }
    })
    return () => { mounted = false; subscription.unsubscribe() }
  }, [refresh])

  const avgRating = (employeeId: string) => {
    const list = reviews.filter((review) => review.employee_id === employeeId)
    return list.length ? list.reduce((sum, review) => sum + review.rating, 0) / list.length : 0
  }
  const filteredEmployees = useMemo(() => employees.filter((employee) => {
    const textMatches = `${employee.name} ${employee.job_title} ${employee.department} ${employee.email}`.toLowerCase().includes(search.toLowerCase())
    const days = daysUntil(employee.contract_end)
    const dateMatches = section !== 'Contracts' || (days >= 0 && (filter === 'all' || (filter === '30' && days <= 30) || (filter === '90' && days <= 90) || (filter === '180' && days <= 180)))
    return textMatches && dateMatches && (section === 'Contracts' ? employee.status === 'active' : true)
  }), [employees, search, filter, section])

  async function markNotificationRead(id: string) {
    const { error: readError } = await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id)
    if (readError) { setError(readError.message); return }
    await refresh()
  }

  async function saveNotificationPreferences(form: FormData) {
    if (!session) return
    setSavingPreferences(true)
    const next = {
      user_id: session.user.id,
      meeting_email_enabled: preferences.meeting_email_enabled,
      in_app_enabled: form.get('in_app_enabled') === 'on',
      contract_email_enabled: preferences.contract_email_enabled,
      updated_at: new Date().toISOString(),
    }
    const { error: preferenceError } = await supabase.from('notification_preferences').upsert(next, { onConflict: 'user_id' })
    setSavingPreferences(false)
    if (preferenceError) { setError('Notification preferences could not be saved.'); return }
    setPreferences(next)
    setModal(null)
  }

  async function saveEmployee(form: FormData) {
    setError('')
    const person = { name: String(form.get('name')).trim(), email: String(form.get('email')).trim(), phone: String(form.get('phone') || ''), job_title: String(form.get('job_title')).trim(), department: String(form.get('department')).trim(), contract_start: String(form.get('contract_start')), contract_end: String(form.get('contract_end')), status: String(form.get('status') || 'active') }
    if (person.contract_end < person.contract_start) { setError('Contract end date must be on or after the start date.'); return }
    let employeeId = editingEmployee?.id
    if (editingEmployee) {
      const { error: updateError } = await supabase.from('employees').update(person).eq('id', editingEmployee.id)
      if (updateError) { setError(updateError.message); return }
    } else {
      const { data, error: insertError } = await supabase.from('employees').insert(person).select('id').single()
      if (insertError) { setError(insertError.message); return }
      employeeId = data.id
    }
    const rateValue = String(form.get('hourly_rate') ?? '').trim()
    const rate = Number(rateValue)
    if (role === 'admin' && employeeId && rateValue && Number.isFinite(rate) && rate >= 0) {
      const effectiveFrom = String(form.get('rate_effective_from') || person.contract_start)
      const { error: rateError } = await supabase.from('employee_rates').insert({ employee_id: employeeId, hourly_rate: rate, effective_from: effectiveFrom, created_by: session?.user.id })
      if (rateError) { setError(`Employee saved, but pay rate was not saved: ${rateError.message}`); return }
    }
    setModal(null); setEditingEmployee(null); await refresh()
  }
  async function endEmployee(employee: Employee) {
    if (!window.confirm(`Mark ${employee.name} as ended? Their records will be retained.`)) return
    const { error: updateError } = await supabase.from('employees').update({ status: 'ended' }).eq('id', employee.id)
    if (updateError) { setError(updateError.message); return }
    setModal(null); setEditingEmployee(null); await refresh()
  }
  async function saveMeeting(form: FormData) {
    setError('')
    setGoogleAuthorizationUrl('')
    const startsAt = new Date(String(form.get('starts_at')))
    if (Number.isNaN(startsAt.getTime())) { setError('Choose a valid meeting date and time.'); return }
    const response = await fetch('/api/meetings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: String(form.get('title')).trim(), startsAt: startsAt.toISOString(), durationMinutes: Number(form.get('duration_minutes')), agenda: String(form.get('agenda') || ''), attendees: String(form.get('attendees') || '').split(',').map((entry) => entry.trim()).filter(Boolean) }) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) { setError(result.error ?? 'The meeting could not be saved.'); setGoogleAuthorizationUrl(result.authorizationUrl ?? ''); return }
    setModal(null); await refresh()
  }
  async function retrieveMeetTranscript(meetingId: string) {
    setError('')
    setGoogleAuthorizationUrl('')
    const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/transcript`)
    const result = await response.json().catch(() => ({}))
    if (!response.ok) { setError(result.error ?? 'Google Meet transcript could not be retrieved.'); setGoogleAuthorizationUrl(result.authorizationUrl ?? ''); return }
    setTranscriptText(result.content)
    setTranscriptSource('upload')
    setTranscriptMeetingId(meetingId)
    setModal('transcript')
  }
  async function saveReview(form: FormData) {
    setError('')
    const rating = Number(form.get('rating'))
    const { error: reviewError } = await supabase.from('reviews').insert({ employee_id: String(form.get('employee_id')), review_date: String(form.get('review_date')), rating, punctuality: Number(form.get('punctuality')), quality: Number(form.get('quality')), communication: Number(form.get('communication')), teamwork: Number(form.get('teamwork')), comments: String(form.get('comments') || ''), reviewer_id: session?.user.id })
    if (reviewError) { setError(reviewError.message); return }
    setModal(null); await refresh()
  }
  async function saveTimesheet(form: FormData) {
    setError('')
    const person = employees.find((entry) => entry.id === String(form.get('employee_id')))
    const date = String(form.get('work_date'))
    const hours = Number(form.get('hours'))
    if (!person || person.status !== 'active' || date < person.contract_start || date > person.contract_end) { setError('Choose an active employee and a work date within their contract period.'); return }
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) { setError('Enter hours greater than 0 and no more than 24 for one workday.'); return }
    const { error: entryError } = await supabase.from('timesheets').insert({ employee_id: person.id, work_date: date, hours, notes: String(form.get('notes') || ''), created_by: session?.user.id })
    if (entryError) { setError(entryError.message); return }
    setModal(null); await refresh()
  }
  async function saveTranscript(form: FormData) {
    setError('')
    const response = await fetch('/api/transcripts/extract', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ meetingId: String(form.get('meeting_id')), content: String(form.get('content')), source: String(form.get('source') || 'pasted') }) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) { setError(result.error ?? 'Transcript could not be saved.'); return }
    setModal(null); setTranscriptText(''); setTranscriptSource('pasted'); setTranscriptMeetingId(''); setSelectedActionIds([]); setTranscriptResults(null); setTranscriptQuery(''); setSection('Transcript review'); await refresh()
    setError(`${result.suggestions?.length ?? 0} suggestions saved for review. Nothing was added to a calendar.`)
  }
  async function searchTranscripts(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = transcriptQuery.trim()
    if (query.length < 2) { setError('Enter at least 2 characters to search transcripts.'); return }
    setError('')
    const response = await fetch(`/api/transcripts/search?q=${encodeURIComponent(query)}`)
    const result = await response.json().catch(() => ({}))
    if (!response.ok) { setError(result.error ?? 'Transcript search is unavailable.'); return }
    setTranscriptResults((result.transcripts ?? []) as TranscriptSearchResult[])
  }

  async function openTranscript(id: string) {
    setTranscriptDetailLoading(true)
    setSelectedTranscript(null)
    const response = await fetch(`/api/transcripts/${encodeURIComponent(id)}`)
    const result = await response.json().catch(() => ({}))
    setTranscriptDetailLoading(false)
    if (!response.ok) { setError(result.error ?? 'Transcript could not be loaded.'); return }
    setSelectedTranscript(result.transcript as TranscriptDetail)
  }

  async function approveActionItems() {
    setGoogleAuthorizationUrl('')
    const selected = actionItems.filter((item) => selectedActionIds.includes(item.id))
    if (!selected.length) { setError('Select at least one suggestion to approve.'); return }
    setError('')
    const response = await fetch('/api/action-items/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionIds: selected.map((item) => item.id),
        edits: selected.map((item) => ({ id: item.id, title: item.title, dueAt: item.due_at })),
      }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) { setError(result.error ?? 'The selected actions could not be approved.'); setGoogleAuthorizationUrl(result.authorizationUrl ?? ''); return }
    setSelectedActionIds([])
    await refresh()
    setError(result.calendarConfigured
      ? `${result.approved} action(s) approved; ${result.calendarAdded} dated item(s) added to your Google Calendar.`
      : `${result.approved} action(s) approved. Dated items are saved in StaffTrack; connect Google Calendar to add them to your calendar.`)
  }
  async function extendContract(employee: Employee) {
    const nextEnd = window.prompt(`New contract end date for ${employee.name} (YYYY-MM-DD)`, employee.contract_end)
    if (!nextEnd || nextEnd <= employee.contract_end) return
    const parsedEnd = new Date(`${nextEnd}T00:00:00.000Z`)
    const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(nextEnd)
      && !Number.isNaN(parsedEnd.getTime())
      && parsedEnd.toISOString().slice(0, 10) === nextEnd
    if (!isValidDate || nextEnd <= employee.contract_end) {
      setError('Enter a valid contract end date later than the current end date.')
      return
    }
    const { error: extensionError } = await supabase.from('contract_extensions').insert({ employee_id: employee.id, old_end_date: employee.contract_end, new_end_date: nextEnd, changed_by: session?.user.id })
    if (extensionError) { setError(extensionError.message); return }
    const { error: updateError } = await supabase.from('employees').update({ contract_end: nextEnd }).eq('id', employee.id)
    if (updateError) { setError(`Extension history was saved, but the employee record was not updated: ${updateError.message}`); return }
    await refresh()
  }

  if (!session) return <AuthScreen />
  const activeCount = employees.filter((person) => person.status === 'active').length
  const endingSoon = employees.filter((person) => person.status === 'active' && daysUntil(person.contract_end) >= 0 && daysUntil(person.contract_end) <= 90).length
  const todaysMeetings = meetings.filter((meeting) => new Date(meeting.starts_at).toDateString() === new Date().toDateString())
  const topRated = [...employees].sort((a, b) => avgRating(b.id) - avgRating(a.id)).slice(0, 4)
  const employeeRows = filteredEmployees.filter((person) => ['all', 'rating_desc', 'rating_asc'].includes(filter) || person.status === filter)
  if (filter === 'rating_desc') employeeRows.sort((a, b) => avgRating(b.id) - avgRating(a.id))
  if (filter === 'rating_asc') employeeRows.sort((a, b) => avgRating(a.id) - avgRating(b.id))

  return <div className="app-shell">
    <aside id="primary-navigation" className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <a className="brand" href="#overview" onClick={() => setSection('Overview')}><span className="brand-mark"><Activity size={19} strokeWidth={2.5} /></span><span>staff<span className="brand-light">track</span><small>PEOPLE OPERATIONS</small></span></a>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="main-nav" aria-label="Main navigation">{nav.map(({ name, icon: Icon }) => <button key={name} className={`nav-item ${section === name ? 'nav-active' : ''}`} aria-current={section === name ? 'page' : undefined} onClick={() => { setSection(name); setMobileNav(false) }}><Icon size={18} /><span>{name}</span>{name === 'Contracts' && endingSoon > 0 && <span className="nav-badge">{endingSoon}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><ShieldCheck size={17} /></div><strong>Your data, protected</strong><p>Employee information is secured with role-based access.</p><button onClick={() => setError('Pay records are restricted to staff accounts assigned the admin role.')}>Security details <ChevronRight size={14} /></button></div><button className="profile-button"><div className="avatar avatar-dark">{initials(session.user.email ?? 'Team')}</div><span className="profile-copy"><strong>{session.user.email?.split('@')[0]}</strong><small>{role ?? 'Role not assigned'}</small></span><ChevronDown size={15} /></button></div>
    </aside>
    {mobileNav && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <main className="main-area">
      <header className="topbar"><button className="mobile-menu icon-button" aria-label={mobileNav ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileNav} aria-controls="primary-navigation" onClick={() => setMobileNav((open) => !open)}><Menu size={19} /></button><div className="breadcrumb"><span>StaffTrack</span><ChevronRight size={14} /><strong>{section}</strong></div><div className="top-actions"><div className="search-box"><Search size={16} /><input aria-label="Search employees" placeholder="Search anything..." value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>⌘ K</kbd></div><div className="notification-wrap"><button className="icon-button notification-button" aria-label={`${noticeCount} unread notifications`} aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen((open) => !open)}><Bell size={18} />{noticeCount > 0 && <i />}</button>{notificationsOpen && <div className="notification-popover" role="region" aria-label="Notifications"><div className="notification-title"><strong>Reminders</strong><span>{noticeCount} unread</span></div>{notifications.map((item) => <div className={`notification-item ${item.read_at ? 'notification-read' : ''}`} key={item.id}><div><strong>{item.title}</strong><p>{item.body}</p><small>{new Date(item.created_at).toLocaleString('en-ZA')}</small></div>{!item.read_at && <button className="text-button" onClick={() => void markNotificationRead(item.id)}>Mark read</button>}</div>)}{notifications.length === 0 && <div className="empty-line">You’re all caught up.</div>}</div>}</div><span className="top-divider" /><button className="icon-button" aria-label="Notification settings" onClick={() => setModal('settings')}><Settings2 size={18} /></button><button className="icon-button" aria-label="Sign out" onClick={() => void supabase.auth.signOut()}><LogOut size={17} /></button></div></header>
      <div className="page-wrap">
        <div className="page-heading"><div><div className="eyebrow">{new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()} <span className="eyebrow-dot" /> YOUR TEAM AT A GLANCE</div><h1>{section === 'Overview' ? 'Good morning' : section}<span className="heading-period">{section === 'Overview' ? ', team.' : ''}</span></h1><p>{section === 'Overview' ? 'Here’s what’s happening across your workforce today.' : section === 'Contracts' ? 'Keep every contract on track and plan ahead.' : `Manage your ${section.toLowerCase()} in one place.`}</p></div><div className="heading-actions"><button className="button button-outline" onClick={() => void supabase.auth.signOut()}><LogOut size={15} /> Sign out</button>{(section === 'Employees' || section === 'Overview') && <button className="button button-primary" onClick={() => { setError(''); setEditingEmployee(null); setModal('employee') }}><Plus size={17} /> Add employee</button>}{section === 'Meetings' && <button className="button button-primary" onClick={() => setModal('meeting')}><Plus size={17} /> Schedule meeting</button>}</div></div>
        {error && <div className="inline-notice" role="status"><span>{error}</span>{googleAuthorizationUrl && <a className="button button-outline button-small" href={googleAuthorizationUrl} target="_blank" rel="noreferrer">Connect Google Calendar</a>}<button aria-label="Dismiss message" onClick={() => { setError(''); setGoogleAuthorizationUrl('') }}><X size={15} /></button></div>}
        {role === null && !loading && <div className="inline-notice role-notice"><ShieldCheck size={17} /><span>You’re signed in, but your administrator needs to assign your <strong>admin</strong> or <strong>manager</strong> role in Supabase before team data is available.</span></div>}
        {loading ? <div className="loading-state">Loading your workspace…</div> : role === null ? <div className="empty-access"><div className="empty-icon"><ShieldCheck size={24} /></div><h2>Your workspace is ready</h2><p>Ask a workspace admin to assign your role. New accounts are not granted permissions automatically.</p></div> : <>
          {section === 'Overview' && <>
            <div className={`stats-grid ${role === 'admin' ? 'stats-grid-admin' : ''}`}><StatCard label="Active employees" value={String(activeCount).padStart(2, '0')} trend="Across your organization" icon={<Users size={18} />} tone="teal" /><StatCard label="Contracts ending soon" value={String(endingSoon).padStart(2, '0')} trend="Within the next 90 days" icon={<CalendarRange size={18} />} tone="amber" /><StatCard label="Upcoming meetings" value={String(meetings.length).padStart(2, '0')} trend="Scheduled ahead" icon={<CalendarDays size={18} />} tone="violet" /><StatCard label="Unread reminders" value={String(noticeCount).padStart(2, '0')} trend="You’re all caught up" icon={<Bell size={18} />} tone="blue" />{role === 'admin' && <StatCard label="This month’s estimated pay" value={payEstimate === null ? '—' : zar(payEstimate)} trend="From logged hours only" icon={<WalletCards size={18} />} tone="teal" />}</div>
            {todaysMeetings.length > 0 && <section className="today-banner"><div className="today-mark"><CalendarDays size={19} /></div><div className="today-copy"><strong>You have {todaysMeetings.length} meeting{todaysMeetings.length === 1 ? '' : 's'} today</strong><span>{todaysMeetings.map((meeting) => meeting.title).join(' · ')}</span></div><button onClick={() => setSection('Meetings')}>View schedule <ChevronRight size={15} /></button></section>}
            <div className="dashboard-grid"><section className="panel employee-panel"><PanelHeader title="People overview" subtitle="Your active workforce" action="All employees" onAction={() => setSection('Employees')} /><EmployeeTable employees={employees.filter((person) => person.status === 'active').slice(0, 5)} avgRating={avgRating} empty="No employees yet. Add your first employee to get started." onEdit={(employee) => { setEditingEmployee(employee); setModal('employee') }} onView={(employee) => { setProfileEmployee(employee); setModal('profile') }} /></section><section className="panel contract-panel"><PanelHeader title="Contract watch" subtitle="Coming up next" action="View all" onAction={() => setSection('Contracts')} />{employees.filter((person) => person.status === 'active').slice(0, 4).map((person) => <ContractRow key={person.id} employee={person} />)}{employees.length === 0 && <EmptyLine text="No contracts to track yet." />}</section><section className="panel top-panel"><PanelHeader title="Top-rated people" subtitle="Based on employer reviews" action="See reviews" onAction={() => setSection('Reviews')} />{topRated.filter((person) => avgRating(person.id) > 0).map((person, index) => <div className="top-person" key={person.id}><span className="rank">0{index + 1}</span><div className="avatar avatar-soft">{initials(person.name)}</div><div className="top-person-copy"><strong>{person.name}</strong><small>{person.job_title}</small></div><span className="rating"><Star size={13} fill="currentColor" />{avgRating(person.id).toFixed(1)}</span></div>)}{topRated.every((person) => avgRating(person.id) === 0) && <EmptyLine text="Add a review to see team ratings here." />}</section><section className="panel activity-panel"><PanelHeader title="Quick actions" subtitle="Common tasks" /><div className="quick-actions"><QuickAction icon={<Star size={17} />} title="Write a review" sub="Share employee feedback" onClick={() => setModal('review')} /><QuickAction icon={<Clock3 size={17} />} title="Log work hours" sub="Record a timesheet entry" onClick={() => setModal('timesheet')} /><QuickAction icon={<CalendarDays size={17} />} title="Schedule a meeting" sub="Plan your next check-in" onClick={() => setModal('meeting')} /></div></section></div>
          </>}
          {section === 'Employees' && <section className="panel full-panel"><div className="table-toolbar"><div><strong>All employees</strong><small>{employees.length} team members</small></div><div className="toolbar-actions"><select aria-label="Filter or sort employees" onChange={(event) => setFilter(event.target.value)}><option value="all">All employees</option><option value="active">Active only</option><option value="ended">Ended contracts</option><option value="rating_desc">Highest rated</option><option value="rating_asc">Lowest rated</option></select><button className="button button-primary button-small" onClick={() => { setEditingEmployee(null); setModal('employee') }}><Plus size={15} /> Add employee</button></div></div><EmployeeTable employees={employeeRows} avgRating={avgRating} empty="No employees match your search." onEdit={(employee) => { setEditingEmployee(employee); setModal('employee') }} onView={(employee) => { setProfileEmployee(employee); setModal('profile') }} /></section>}
          {section === 'Contracts' && <section className="panel full-panel"><div className="table-toolbar"><div><strong>Contract end tracker</strong><small>{filteredEmployees.length} active contracts</small></div><div className="toolbar-actions"><select aria-label="Filter contracts by end date" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All contracts</option><option value="30">Next 30 days</option><option value="90">Next 3 months</option><option value="180">Next 6 months</option></select></div></div><div className="contract-list">{filteredEmployees.map((person) => <div className="contract-card" key={person.id}><div className="avatar avatar-soft">{initials(person.name)}</div><div className="contract-info"><strong>{person.name}</strong><span>{person.job_title} · {person.department}</span></div><div className="contract-date"><small>CONTRACT ENDS</small><strong>{fmtDate(person.contract_end)}</strong></div><ExpiryBadge days={daysUntil(person.contract_end)} /><button className="button button-outline button-small" onClick={() => void extendContract(person)}>Extend</button></div>)}{filteredEmployees.length === 0 && <EmptyLine text="No contracts found for this period." />}</div></section>}
          {section === 'Reviews' && <section className="panel full-panel"><div className="table-toolbar"><div><strong>Employee reviews</strong><small>Ratings and feedback from your team</small></div><button className="button button-primary button-small" onClick={() => setModal('review')}><Plus size={15} /> Add review</button></div><div className="review-list">{employees.map((person) => <div className="review-person" key={person.id}><div className="avatar avatar-soft">{initials(person.name)}</div><div className="review-person-copy"><strong>{person.name}</strong><small>{person.job_title} · {reviews.filter((review) => review.employee_id === person.id).length} reviews</small></div><span className="rating"><Star size={14} fill="currentColor" />{avgRating(person.id) ? avgRating(person.id).toFixed(1) : '—'}</span><button className="text-button" onClick={() => setModal('review')}>Add review</button></div>)}{employees.length === 0 && <EmptyLine text="Add employees before writing reviews." />}</div></section>}
          {section === 'Timesheets & pay' && <section className="panel full-panel"><div className="table-toolbar"><div><strong>Timesheets & pay</strong><small>Pay is calculated only from logged hours, using the rate effective on each work date.</small></div><button className="button button-primary button-small" onClick={() => setModal('timesheet')}><Plus size={15} /> Log hours</button></div><div className="pay-notice"><ShieldCheck size={18} /><div><strong>Pay details are admin-only</strong><p>{role === 'admin' ? 'Rate history and pay reports are restricted to your admin role. Export a monthly report after reviewing logged hours.' : 'Ask an admin if you need access to pay reports.'}</p></div></div>{role === 'admin' && <PayPanel employees={employees} />}</section>}
          {section === 'Meetings' && <section className="panel full-panel"><div className="table-toolbar"><div><strong>Upcoming meetings</strong><small>Schedule Google Calendar events and create Meet links</small></div><div className="toolbar-actions"><a className="button button-outline button-small" href="/api/google/authorize" target="_blank" rel="noreferrer">Connect Google Calendar</a><button className="button button-primary button-small" onClick={() => setModal('meeting')}><Plus size={15} /> Schedule meeting</button></div></div><div className="meeting-list">{meetings.map((meeting) => <div className="meeting-card" key={meeting.id}><div className="meeting-date"><strong>{new Date(meeting.starts_at).toLocaleDateString('en-ZA', { day: '2-digit' })}</strong><span>{new Date(meeting.starts_at).toLocaleDateString('en-ZA', { month: 'short' }).toUpperCase()}</span></div><div className="meeting-copy"><strong>{meeting.title}</strong><span>{new Date(meeting.starts_at).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })} · {meeting.duration_minutes} min · {Array.isArray(meeting.attendees) ? meeting.attendees.length : 0} attendees</span></div>{meeting.teams_url ? <a className="button button-outline button-small" href={meeting.teams_url} target="_blank" rel="noreferrer">Join meeting</a> : <span className="meeting-no-link">No join link</span>}{meeting.teams_url?.startsWith('https://meet.google.com/') && <button className="button button-outline button-small" onClick={() => void retrieveMeetTranscript(meeting.id)}>Fetch transcript</button>}<button className="button button-outline button-small calendar-download" onClick={() => downloadIcs(meeting)}>Add to calendar</button><button className="text-button" onClick={() => { setTranscriptText(''); setTranscriptMeetingId(meeting.id); setModal('transcript') }}>Add transcript</button></div>)}{meetings.length === 0 && <EmptyLine text="No upcoming meetings. Schedule your first team check-in." />}</div></section>}
          {section === 'Transcript review' && <div className="transcript-workspace"><section className="panel full-panel"><div className="table-toolbar"><div><strong>Transcript action review</strong><small>Review every suggested date and action. Approved dated actions can be added to Google Calendar.</small></div><div className="toolbar-actions"><a className="button button-outline button-small" href="/api/google/authorize" target="_blank" rel="noreferrer">Connect Google Calendar</a><button className="button button-primary button-small" onClick={() => { setTranscriptText(''); setTranscriptMeetingId(''); setModal('transcript') }}><Plus size={15} /> Add transcript</button></div></div><div className="action-review-list">{actionItems.map((item) => <div className="action-review-row" key={item.id}><input type="checkbox" aria-label={`Select ${item.title}`} checked={selectedActionIds.includes(item.id)} onChange={(event) => setSelectedActionIds((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} /><div className="action-edit-fields"><label className="field">Suggested action<input value={item.title} onChange={(event) => setActionItems((items) => items.map((entry) => entry.id === item.id ? { ...entry, title: event.target.value } : entry))} /></label><label className="field">Detected date<input type="date" value={item.due_at?.slice(0, 10) ?? ''} onChange={(event) => setActionItems((items) => items.map((entry) => entry.id === item.id ? { ...entry, due_at: event.target.value ? new Date(`${event.target.value}T12:00:00`).toISOString() : null } : entry))} /></label><span className="form-hint">From {transcriptMeetings.find((meeting) => meeting.id === item.meeting_id)?.title ?? 'meeting transcript'}</span></div></div>)}{actionItems.length === 0 && <div className="empty-line">No pending actions. Add a transcript to extract dates and follow-ups for review.</div>}</div>{actionItems.length > 0 && <div className="review-approve-row"><span>{selectedActionIds.length} selected · dated actions sync to Google Calendar when connected</span><button className="button button-primary button-small" onClick={() => void approveActionItems()}>Approve selected</button></div>}</section><section className="panel full-panel"><div className="table-toolbar"><div><strong>Transcript archive</strong><small>Search transcript text and open saved meeting notes.</small></div></div><form className="transcript-search" onSubmit={searchTranscripts}><label className="field">Search transcripts<input value={transcriptQuery} onChange={(event) => setTranscriptQuery(event.target.value)} minLength={2} maxLength={100} placeholder="Find a topic, person, or follow-up" /></label><div className="transcript-search-actions"><button className="button button-primary button-small" type="submit">Search</button>{transcriptResults !== null && <button className="button button-outline button-small" type="button" onClick={() => { setTranscriptResults(null); setTranscriptQuery('') }}>Clear</button>}</div></form><div className="transcript-archive">{(transcriptResults ?? transcriptRecords).map((transcript) => <article className="transcript-record" key={transcript.id}><div className="transcript-record-copy"><strong>{transcriptMeetings.find((meeting) => meeting.id === transcript.meeting_id)?.title ?? 'Meeting transcript'}</strong><span>{new Date(transcript.created_at).toLocaleString('en-ZA')} · {transcript.source === 'upload' ? 'Uploaded file' : 'Pasted text'}</span>{'snippet' in transcript && typeof transcript.snippet === 'string' && <p>{transcript.snippet}</p>}</div><button className="button button-outline button-small" onClick={() => void openTranscript(transcript.id)}>View transcript</button></article>)}{(transcriptResults ?? transcriptRecords).length === 0 && <div className="empty-line">{transcriptResults === null ? 'No transcripts have been added yet.' : 'No transcripts matched that search.'}</div>}</div></section></div>}
        </>}
        <footer className="page-footer"><span>© 2026 StaffTrack</span><span><ShieldCheck size={13} /> Built for responsible people operations</span><span>South Africa · ZAR</span></footer>
      </div>
    </main>
    {modal && <Modal title={modal === 'employee' ? editingEmployee ? 'Edit employee' : 'Add employee' : modal === 'meeting' ? 'Schedule a meeting' : modal === 'review' ? 'Write an employee review' : modal === 'timesheet' ? 'Log work hours' : modal === 'profile' ? 'Employee profile' : modal === 'settings' ? 'Notification preferences' : 'Add a transcript'} onClose={() => setModal(null)}>
      {modal === 'settings' && <form action={saveNotificationPreferences} className="form-grid"><p className="form-hint full-field">Choose whether StaffTrack should create in-app reminders for your account.</p><label className="field full-field"><span>In-app notifications</span><input type="checkbox" name="in_app_enabled" defaultChecked={preferences.in_app_enabled} /></label><div className="form-actions full-field"><button className="button button-outline" type="button" onClick={() => setModal(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={savingPreferences}>{savingPreferences ? 'Saving…' : 'Save preferences'}</button></div></form>}
      {modal === 'employee' && <form action={saveEmployee} className="form-grid"><label className="field full-field">Full name<input name="name" required defaultValue={editingEmployee?.name} placeholder="e.g. Thandi Mokoena" /></label><label className="field">Work email<input type="email" name="email" required defaultValue={editingEmployee?.email} placeholder="name@company.co.za" /></label><label className="field">Phone number<input name="phone" defaultValue={editingEmployee?.phone ?? ''} placeholder="+27 82 000 0000" /></label><label className="field">Job title<input name="job_title" required defaultValue={editingEmployee?.job_title} placeholder="Project coordinator" /></label><label className="field">Department<input name="department" required defaultValue={editingEmployee?.department} placeholder="Operations" /></label><label className="field">Contract start<input type="date" name="contract_start" required defaultValue={editingEmployee?.contract_start} /></label><label className="field">Contract end<input type="date" name="contract_end" required defaultValue={editingEmployee?.contract_end} /></label>{editingEmployee && <label className="field full-field">Status<select name="status" defaultValue={editingEmployee.status}><option value="active">Active</option><option value="ended">Ended</option></select></label>}{role === 'admin' && <><label className="field">Hourly rate (ZAR)<input type="number" name="hourly_rate" min="0" step="0.01" required={!editingEmployee} placeholder={editingEmployee ? 'Leave blank to keep existing rate' : '0.00'} /></label><label className="field">Rate effective from<input type="date" name="rate_effective_from" defaultValue={editingEmployee?.contract_start} /></label></>}<FormButtons onCancel={() => { setModal(null); setEditingEmployee(null) }} submit={editingEmployee ? 'Save changes' : 'Save employee'} /></form>}
      {modal === 'profile' && profileEmployee && <div className="profile-details"><div className="profile-summary"><div className="avatar avatar-soft">{initials(profileEmployee.name)}</div><div><h3>{profileEmployee.name}</h3><p>{profileEmployee.job_title} · {profileEmployee.department}</p></div></div><div className="profile-facts"><span>Email</span><strong>{profileEmployee.email}</strong><span>Phone</span><strong>{profileEmployee.phone || 'Not provided'}</strong><span>Status</span><strong className="capitalize">{profileEmployee.status}</strong><span>Contract starts</span><strong>{fmtDate(profileEmployee.contract_start)}</strong><span>Contract ends</span><strong>{fmtDate(profileEmployee.contract_end)} · {daysUntil(profileEmployee.contract_end)} days</strong><span>Average review</span><strong>{avgRating(profileEmployee.id) ? `${avgRating(profileEmployee.id).toFixed(1)} / 5` : 'No reviews yet'}</strong></div><section className="profile-history"><h4>Rating history</h4><ReviewHistoryChart reviews={reviews.filter((review) => review.employee_id === profileEmployee.id)} /></section><div className="form-actions"><button className="button button-outline" onClick={() => setModal(null)}>Close</button><button className="button button-primary" onClick={() => { setEditingEmployee(profileEmployee); setModal('employee') }}>Edit profile</button></div></div>}
      {modal === 'meeting' && <form action={saveMeeting} className="form-grid"><p className="form-hint full-field">StaffTrack will create a Google Calendar event, invite attendees, and generate a Google Meet link using your connected account.</p><label className="field full-field">Meeting title<input name="title" required placeholder="Weekly project check-in" /></label><label className="field">Date and time<input type="datetime-local" name="starts_at" required /></label><label className="field">Duration (minutes)<input type="number" name="duration_minutes" min="5" step="5" defaultValue="30" required /></label><label className="field full-field">Attendees <small>Separate emails with commas</small><input name="attendees" placeholder="thandi@company.co.za, sam@company.co.za" /></label><label className="field full-field">Agenda<textarea name="agenda" rows={3} placeholder="What would you like to cover?" /></label><FormButtons onCancel={() => setModal(null)} submit="Schedule meeting" /></form>}
      {modal === 'review' && <form action={saveReview} className="form-grid"><label className="field full-field">Employee<select name="employee_id" required defaultValue=""><option value="" disabled>Select an employee</option>{employees.map((person) => <option value={person.id} key={person.id}>{person.name} — {person.job_title}</option>)}</select></label><label className="field">Review date<input type="date" name="review_date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label><label className="field">Overall rating<select name="rating" defaultValue="5">{[5,4,3,2,1].map((value) => <option key={value} value={value}>{value} / 5</option>)}</select></label>{(['punctuality','quality','communication','teamwork'] as const).map((category) => <label className="field" key={category}>{category[0].toUpperCase() + category.slice(1)}<select name={category} defaultValue="5">{[5,4,3,2,1].map((value) => <option key={value} value={value}>{value} / 5</option>)}</select></label>)}<label className="field full-field">Feedback<textarea name="comments" rows={4} placeholder="Share constructive, specific feedback…" /></label><FormButtons onCancel={() => setModal(null)} submit="Save review" /></form>}
      {modal === 'timesheet' && <form action={saveTimesheet} className="form-grid"><label className="field full-field">Employee<select name="employee_id" required defaultValue=""><option value="" disabled>Select an employee</option>{employees.filter((person) => person.status === 'active').map((person) => <option key={person.id} value={person.id}>{person.name} · {fmtDate(person.contract_start)} – {fmtDate(person.contract_end)}</option>)}</select></label><label className="field">Work date<input type="date" name="work_date" required /></label><label className="field">Hours worked<input type="number" name="hours" min="0.25" max="24" step="0.25" required placeholder="8" /></label><label className="field full-field">Notes<textarea name="notes" rows={3} placeholder="Optional details about work completed" /></label><FormButtons onCancel={() => setModal(null)} submit="Save timesheet" /></form>}
      {modal === 'transcript' && <form action={saveTranscript} className="form-grid"><label className="field full-field">Meeting<select name="meeting_id" required value={transcriptMeetingId} onChange={(event) => setTranscriptMeetingId(event.target.value)}><option value="" disabled>Select a meeting</option>{transcriptMeetings.map((meeting) => <option value={meeting.id} key={meeting.id}>{meeting.title}</option>)}</select></label><label className="field full-field">Upload transcript (.vtt or .txt)<input type="file" accept=".vtt,.txt,text/vtt,text/plain" onChange={async (event) => { const file = event.currentTarget.files?.[0]; if (!file) return; if (!/\.(vtt|txt)$/i.test(file.name)) { setError('Choose a .vtt or .txt transcript file.'); return } setTranscriptText(await file.text()); setTranscriptSource('upload') }} /></label><input type="hidden" name="source" value={transcriptSource} /><label className="field full-field">Transcript text<textarea name="content" rows={8} required value={transcriptText} onChange={(event) => { setTranscriptText(event.target.value); setTranscriptSource('pasted') }} placeholder="Paste transcript text here or upload a file…" /></label><p className="form-hint full-field">Dates on follow-up/action lines are suggestions only. Review and edit every suggestion before approving.</p><FormButtons onCancel={() => { setModal(null); setTranscriptText('') }} submit="Extract suggestions" /></form>}
    </Modal>}
    {(selectedTranscript || transcriptDetailLoading) && <Modal title={selectedTranscript ? transcriptMeetings.find((meeting) => meeting.id === selectedTranscript.meeting_id)?.title ?? 'Meeting transcript' : 'Loading transcript'} onClose={() => { setSelectedTranscript(null); setTranscriptDetailLoading(false) }}>{transcriptDetailLoading ? <div className="loading-state">Loading transcript…</div> : selectedTranscript && <div className="transcript-detail"><p>{new Date(selectedTranscript.created_at).toLocaleString('en-ZA')} · {selectedTranscript.source === 'upload' ? 'Imported transcript' : 'Pasted text'}</p><pre>{selectedTranscript.content}</pre></div>}</Modal>}
  </div>
}

function AuthScreen() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setSent(false)
    const result = mode === 'signin' ? await supabase.auth.signInWithPassword({ email, password }) : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL ?? `${window.location.origin}/auth/callback` } })
    if (result.error) {
      const message = result.error.message.toLowerCase()
      if (message.includes('invalid login credentials') || message.includes('user already registered')) setError('Unable to sign in with those credentials. Check your email and password, or try signing in instead.')
      else if (message.includes('email not confirmed')) setError('Confirm your email using the link we sent, then sign in.')
      else if (message.includes('password should be') || message.includes('password is too')) setError('Choose a stronger password with at least 8 characters.')
      else if (message.includes('rate limit') || message.includes('too many requests')) setError('Too many attempts. Wait a little and try again.')
      else setError('StaffTrack could not complete sign-in. Try again or contact your workspace administrator.')
    } else if (mode === 'signup' && !result.data.session) setSent(true)
  }
  return <div className="auth-screen"><div className="auth-card"><a className="brand auth-brand" href="#"><span className="brand-mark"><Activity size={19} strokeWidth={2.5} /></span><span>staff<span className="brand-light">track</span><small>PEOPLE OPERATIONS</small></span></a><div className="auth-kicker">WELCOME TO YOUR WORKSPACE</div><h1>{mode === 'signin' ? 'A better way to work, together.' : 'Create your team account.'}</h1><p className="auth-intro">One calm, clear view of your people, contracts and meetings.</p>{sent ? <div className="auth-success">Check your inbox for a confirmation link, then sign in.</div> : <form className="auth-form" onSubmit={submit}><label className="field">Work email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" placeholder="you@company.co.za" /></label><label className="field">Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} placeholder="At least 8 characters" /></label>{error && <p className="auth-error" role="alert">{error}</p>}<button className="button button-primary auth-submit" type="submit">{mode === 'signin' ? 'Sign in' : 'Create account'} <ChevronRight size={16} /></button></form>}<p className="auth-switch">{mode === 'signin' ? 'New to StaffTrack?' : 'Already have an account?'} <button onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); setSent(false) }}>{mode === 'signin' ? 'Create an account' : 'Sign in'}</button></p><div className="auth-foot"><ShieldCheck size={14} /> Secure sign-in powered by Supabase</div></div><div className="auth-decoration"><div className="orb orb-one"/><div className="orb orb-two"/><div className="auth-quote"><div className="quote-mark">“</div><p>Great teams aren’t managed.<br />They’re <em>understood.</em></p><span>PEOPLE FIRST, ALWAYS</span></div></div></div>
}

function StatCard({ label, value, trend, icon, tone }: { label: string; value: string; trend: string; icon: React.ReactNode; tone: string }) { return <div className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon ${tone}`}>{icon}</span></div><div className="stat-value">{value}</div><div className="stat-trend"><span className="trend-dot" />{trend}</div></div> }
function PanelHeader({ title, subtitle, action, onAction }: { title: string; subtitle: string; action?: string; onAction?: () => void }) { return <div className="panel-header"><div><h2>{title}</h2><p>{subtitle}</p></div>{action && <button className="panel-link" onClick={onAction}>{action}<ChevronRight size={14} /></button>}</div> }
function EmployeeTable({ employees, avgRating, empty, onEdit, onView }: { employees: Employee[]; avgRating: (id: string) => number; empty: string; onEdit?: (employee: Employee) => void; onView?: (employee: Employee) => void }) { return <div className="employee-table-wrap"><table className="employee-table"><thead><tr><th>EMPLOYEE</th><th>DEPARTMENT</th><th>CONTRACT END</th><th>RATING</th><th>STATUS</th><th>ACTIONS</th></tr></thead><tbody>{employees.map((person) => <tr key={person.id}><td><div className="person-cell"><div className="avatar avatar-soft">{initials(person.name)}</div><div><button className="employee-name-button" onClick={() => onView?.(person)}>{person.name}</button><small>{person.job_title}</small></div></div></td><td>{person.department}</td><td>{fmtDate(person.contract_end)}</td><td><span className="rating"><Star size={13} fill="currentColor" />{avgRating(person.id) ? avgRating(person.id).toFixed(1) : '—'}</span></td><td><span className={`status-pill ${person.status}`}>{person.status === 'active' ? 'Active' : 'Ended'}</span></td><td><button className="text-button" onClick={() => onEdit?.(person)}>Edit</button></td></tr>)}</tbody></table>{employees.length === 0 && <EmptyLine text={empty} />}</div> }
function ContractRow({ employee }: { employee: Employee }) { const days = daysUntil(employee.contract_end); return <div className="contract-row"><div className="avatar avatar-soft">{initials(employee.name)}</div><div className="contract-row-copy"><strong>{employee.name}</strong><small>{employee.job_title}</small></div><div className="contract-row-date"><strong>{fmtDate(employee.contract_end)}</strong><ExpiryBadge days={days} /></div></div> }
function ExpiryBadge({ days }: { days: number }) { const band = contractExpiryBand(days); const tone = band === 'amber' ? 'yellow' : band === 'ended' ? 'red' : band; const text = days < 0 ? 'Ended' : days === 0 ? 'Today' : days < 30 ? `${days} days` : days < 90 ? `${Math.floor(days / 30)} mo ${days % 30}d` : `${Math.floor(days / 30)} months`; return <span className={`expiry-badge ${tone}`}><i />{text}</span> }
function EmptyLine({ text }: { text: string }) { return <div className="empty-line">{text}</div> }
function QuickAction({ icon, title, sub, onClick }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void }) { return <button className="quick-action" onClick={onClick}><span className="quick-icon">{icon}</span><span><strong>{title}</strong><small>{sub}</small></span><ChevronRight size={15} /></button> }
function FormButtons({ onCancel, submit }: { onCancel: () => void; submit: string }) { return <div className="form-actions full-field"><button className="button button-outline" type="button" onClick={onCancel}>Cancel</button><button className="button button-primary" type="submit">{submit}</button></div> }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
    ;(focusables()[0] ?? dialog)?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) {
        event.preventDefault()
        dialog?.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [])

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1}><div className="modal-heading"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></div>{children}</section></div>
}
function PayPanel({ employees }: { employees: Employee[] }) { const [items, setItems] = useState<{ employee_id: string; hourly_rate: number; effective_from: string }[]>([]); const [entries, setEntries] = useState<{ employee_id: string; work_date: string; hours: number }[]>([]); const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)); const [denied, setDenied] = useState(false)
  useEffect(() => { let alive = true; Promise.all([supabase.from('employee_rates').select('employee_id,hourly_rate,effective_from').order('effective_from'), supabase.from('timesheets').select('employee_id,work_date,hours').gte('work_date', `${new Date().getFullYear()}-01-01`)]).then(([rates, hours]) => { if (!alive) return; setItems(rates.data ?? []); setEntries(hours.data ?? []); setDenied(Boolean(rates.error || hours.error)) }); return () => { alive = false } }, [])
  const rows = employees.map((employee) => { const time = entries.filter((entry) => entry.employee_id === employee.id && entry.work_date.slice(0, 7) === month); return { employee, hours: time.reduce((sum, entry) => sum + Number(entry.hours), 0), total: calculatePayForEntries(time, items, month) } })
  function exportCsv() { const body = [['Employee','Month','Hours','Estimated pay (ZAR)'], ...rows.map(({ employee, hours, total }) => [employee.name, month, String(hours), total.toFixed(2)])].map((row) => row.map((value) => `"${value.replaceAll('"','""')}"`).join(',')).join('\n'); const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' })); const link = document.createElement('a'); link.href = url; link.download = `stafftrack-pay-${month}.csv`; link.click(); URL.revokeObjectURL(url) }
  return <div className="pay-panel"><div className="pay-toolbar"><label className="field">Pay period<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><button className="button button-outline button-small" onClick={exportCsv}><Download size={14} /> Export CSV</button></div>{denied && <p className="form-hint">Pay tables are unavailable for this role or need an admin assignment.</p>}<div className="employee-table-wrap"><table className="employee-table pay-table"><thead><tr><th>EMPLOYEE</th><th>HOURS LOGGED</th><th>ESTIMATED PAY</th></tr></thead><tbody>{rows.map(({ employee, hours, total }) => <tr key={employee.id}><td><div className="person-cell"><div className="avatar avatar-soft">{initials(employee.name)}</div><div><strong>{employee.name}</strong><small>{employee.department}</small></div></div></td><td>{hours} hrs</td><td>{zar(total)}</td></tr>)}</tbody></table></div></div>
}
