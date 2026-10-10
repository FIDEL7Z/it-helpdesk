import { createContext, useContext, type CSSProperties, type ReactNode } from 'react'
import { ResponsiveContainer, Tooltip } from 'recharts'
// CSS-native adaptation of shadcn/ui ChartContainer and ChartTooltipContent.
// https://ui.shadcn.com/docs/components/chart (MIT). No Tailwind runtime required.
export type ChartConfig = Record<string, { label: string; color?: string }>
const ChartContext = createContext<ChartConfig>({})
export function ChartContainer({ config, children, ...props }: { config: ChartConfig; children: ReactNode; 'aria-label': string }) {
  const style = Object.fromEntries(Object.entries(config).filter(([, value]) => value.color).map(([key, value]) => [`--color-${key}`, value.color])) as CSSProperties
  return <ChartContext.Provider value={config}><div className="chart-container" style={style} {...props}><ResponsiveContainer width="100%" height="100%" minWidth={0}>{children}</ResponsiveContainer></div></ChartContext.Provider>
}
export const ChartTooltip = Tooltip
type TooltipEntry = { name?: string | number; dataKey?: string | number; value?: number | string | (number | string)[]; color?: string; payload?: { name?: string; fill?: string } }
export function ChartTooltipContent({ active, payload, label, labelFormatter }: { active?: boolean; payload?: readonly TooltipEntry[]; label?: string | number; labelFormatter?: (label: string | number) => string }) {
  const config = useContext(ChartContext)
  if (!active || !payload?.length) return null
  return <div className="chart-tooltip">{label !== undefined && <strong>{labelFormatter ? labelFormatter(label) : label}</strong>}{payload.map((item, index) => <div key={index}><span className="chart-swatch" style={{ background: item.payload?.fill ?? item.color }} /><span>{item.payload?.name ?? config[String(item.dataKey)]?.label ?? item.name}</span><b>{String(item.value ?? 0)}</b></div>)}</div>
}
