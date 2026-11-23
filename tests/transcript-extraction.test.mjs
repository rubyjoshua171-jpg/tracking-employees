import test from 'node:test'
import assert from 'node:assert/strict'
import { extractActionSuggestions } from '../lib/transcript-extraction.mjs'

test('extracts future dates only from action-related transcript lines', () => {
  const items = extractActionSuggestions([
    'General discussion about staffing levels.',
    'Follow up with the supplier by December 12, 2026.',
    'Next meeting on January 5, 2027 at 2pm.',
  ].join('\n'), new Date('2026-11-23T12:00:00Z'))
  assert.equal(items.length, 2)
  assert.equal(items[0].due_at.slice(0, 10), '2026-12-12')
  assert.equal(items[1].due_at.slice(0, 10), '2027-01-05')
})

test('deduplicates repeated action lines and keeps undated suggestions for review', () => {
  const items = extractActionSuggestions([
    'Action: prepare the draft before the next check-in.',
    'Action: prepare the draft before the next check-in.',
  ].join('\n'), new Date('2026-11-23T12:00:00Z'))
  assert.equal(items.length, 1)
  assert.equal(items[0].due_at, null)
})

test('parses WebVTT captions while ignoring timestamp lines', () => {
  const items = extractActionSuggestions([
    '00:00:01.000 --> 00:00:03.000',
    'Follow up with Sam next Friday.',
  ].join('\n'), new Date('2026-11-23T12:00:00Z'))
  assert.equal(items.length, 1)
  assert.ok(items[0].due_at)
})
