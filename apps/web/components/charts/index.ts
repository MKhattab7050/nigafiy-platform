// Shared chart kit. Every chart reads real API data only, follows the theme through CSS tokens,
// keeps its time axis left-to-right, and carries a text alternative (labels, legend or table).
export { ChartTable } from './chart-table';
export { Sparkline } from './sparkline';
export { Donut, Legend, RingGauge, type Slice } from './ring';
export { BarList, Meter, ProportionBar, loadTone } from './bars';
export { UptimeLegend, UptimeStrip, toCells, uptimeTone, type UptimeCell, type UptimeSample } from './uptime-strip';
export { SeriesLegend, TimeSeriesChart, type SeriesDef, type TimePoint } from './time-series';
export { ColumnChart, type Column } from './column-chart';

/** Fixed series colours, in order. State colours (ok/warn/crit) are never used as series. */
export const SERIES = ['var(--color-series-1)', 'var(--color-series-2)', 'var(--color-series-3)', 'var(--color-series-4)'] as const;
