'use client'

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'

type ReviewPoint = { review_date: string; rating: number }
const chartConfig = { rating: { label: 'Rating', color: 'var(--brand-primary)' } } satisfies ChartConfig

export default function ReviewHistoryChart({ reviews }: { reviews: ReviewPoint[] }) {
  const points = [...reviews].sort((a, b) => a.review_date.localeCompare(b.review_date)).map((review) => ({
    ...review,
    label: new Date(`${review.review_date}T12:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }),
  }))
  if (points.length === 0) return <p className="form-hint">No review history yet.</p>

  return <div role="img" aria-label={`Review rating history, ${points.length} reviews. Latest rating ${points.at(-1)?.rating} out of 5.`}>
    <ChartContainer config={chartConfig} className="h-[175px] w-full">
      <LineChart accessibilityLayer data={points} margin={{ top: 8, right: 12, bottom: 0, left: -22 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--line)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: 'var(--text-muted)' }} />
        <YAxis domain={[1, 5]} ticks={[1, 2, 3, 4, 5]} tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: 'var(--text-muted)' }} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line type="monotone" dataKey="rating" stroke="var(--color-rating)" strokeWidth={2.5} dot={{ r: 3, fill: 'var(--color-rating)' }} activeDot={{ r: 5 }} />
      </LineChart>
    </ChartContainer>
  </div>
}
