import test from 'node:test'
import assert from 'node:assert/strict'
import { calculatePayForEntries, contractDaysRemaining, contractExpiryBand } from '../lib/stafftrack-logic.mjs'

test('pay uses the effective rate on the day each entry was worked', () => {
  const entries = [
    { employee_id: 'a', work_date: '2026-05-02', hours: 8 },
    { employee_id: 'a', work_date: '2026-05-18', hours: 4 },
    { employee_id: 'a', work_date: '2026-04-30', hours: 6 },
  ]
  const rates = [
    { employee_id: 'a', effective_from: '2026-01-01', hourly_rate: 100 },
    { employee_id: 'a', effective_from: '2026-05-10', hourly_rate: 120 },
  ]
  assert.equal(calculatePayForEntries(entries, rates, '2026-05'), 1280)
})

test('pay excludes unlogged time and dates outside the selected month', () => {
  assert.equal(calculatePayForEntries([
    { employee_id: 'a', work_date: '2026-04-30', hours: 8 },
  ], [{ employee_id: 'a', effective_from: '2026-01-01', hourly_rate: 100 }], '2026-05'), 0)
})

test('contract expiry bands follow the 30 and 90 day thresholds', () => {
  assert.equal(contractExpiryBand(29), 'red')
  assert.equal(contractExpiryBand(30), 'amber')
  assert.equal(contractExpiryBand(89), 'amber')
  assert.equal(contractExpiryBand(90), 'green')
  assert.equal(contractExpiryBand(-1), 'ended')
})

test('contract days remaining uses the contract end date', () => {
  assert.equal(contractDaysRemaining('2026-12-01', new Date('2026-11-23T12:00:00.000Z')), 9)
})
