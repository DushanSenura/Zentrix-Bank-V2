import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

/** Kept in its own file so the charting library is downloaded only when a chart is actually shown. */
export default function VolumeChart({ series }: { series: { day: string; volumeMinor: number; count: number }[] }) {
  return (
    <div role="img" aria-label="Bar chart of daily transfer volume" style={{ width: '100%', height: 240 }}>
      <ResponsiveContainer>
        <BarChart data={series.map((s) => ({ day: s.day.slice(5), volume: s.volumeMinor / 100, count: s.count }))}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis dataKey="day" fontSize={12} />
          <YAxis fontSize={12} width={70} tickFormatter={(v: number) => v.toLocaleString()} />
          <Tooltip formatter={(v) => [`LKR ${Number(v).toLocaleString()}`, 'Volume']} />
          <Bar dataKey="volume" fill="var(--zx-primary)" radius={[4, 4, 0, 0]} isAnimationActive />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
