export function contractDaysRemaining(endDate, now = new Date()) {
  const end = new Date(`${endDate}T23:59:59.999Z`)
  return Math.ceil((end.getTime() - now.getTime()) / 86_400_000)
}

export function contractExpiryBand(days) {
  if (days < 0) return 'ended'
  if (days < 30) return 'red'
  if (days < 90) return 'amber'
  return 'green'
}

export function calculatePayForEntries(entries, rates, month) {
  return entries
    .filter((entry) => entry.work_date.slice(0, 7) === month)
    .reduce((total, entry) => {
      const rate = rates
        .filter((item) => item.employee_id === entry.employee_id && item.effective_from <= entry.work_date)
        .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]
      return total + (rate ? Number(entry.hours) * Number(rate.hourly_rate) : 0)
    }, 0)
}
