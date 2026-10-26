"use client";

import { memo, useEffect, useRef, type ReactNode } from "react";
import type { EChartsCoreOption } from "echarts/core";
import type { ChartSpec } from "@/types/assistant";

const PALETTE = [
  "#818cf8", "#22d3ee", "#f472b6", "#34d399", "#fbbf24",
  "#60a5fa", "#fb923c", "#c084fc", "#4ade80", "#f87171",
];
const SERIES_COLORS = ["#818cf8", "#22d3ee", "#f472b6", "#fbbf24"];
const REF_COLORS = ["#fbbf24", "#f87171", "#34d399"];
const PEAK_COLOR = "#a5b4fc";
const UP = "#34d399";
const DOWN = "#f87171";

const TEXT = "#f2f3f5";
const SECONDARY = "#dbdee1";
const MUTED = "#b5bac1";
const FAINT = "#949ba4";
const BORDER = "#3f4147";
const PANEL = "#2b2d31";
const TOOLTIP_BG = "#1e1f22";
const FONT = "inherit";

type Model = {
  labels: string[];
  names: string[];
  rows: number[][];
  refs: { label: string; value: number }[];
  stacked: boolean;
};

function fmtNum(n: number) {
  if (!Number.isFinite(n)) return "0";
  const rounded = Number.isInteger(n) ? n : Math.round(n * 10) / 10;
  return rounded.toLocaleString("ko-KR", {
    maximumFractionDigits: Number.isInteger(rounded) ? 0 : 1,
  });
}

function fmtCompact(n: number, unit: string | null) {
  if (isPercent(unit)) return fmtNum(n);
  const abs = Math.abs(n);
  const scaled = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString("ko-KR");
  if (abs >= 1e8) return `${scaled(n / 1e8)}억`;
  if (abs >= 1e4) return `${scaled(n / 1e4)}만`;
  return fmtNum(n);
}

function shortLabel(label: string, max: number) {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function isPercent(unit: string | null) {
  return unit === "%" || unit === "％";
}

function withUnit(n: number, unit: string | null) {
  return `${fmtNum(n)}${unit ? ` ${unit}` : ""}`;
}

function toModel(chart: ChartSpec): Model {
  const compare = chart.compare ?? [];
  const names = [chart.seriesName || (compare.length ? "현재" : chart.title), ...compare.map((c) => c.name)];
  return {
    labels: chart.series.map((d) => d.label),
    names,
    rows: chart.series.map((d, i) => [d.value, ...compare.map((c) => c.values[i] ?? 0)]),
    refs: chart.refLines ?? [],
    stacked: Boolean(chart.stacked) && compare.length > 0,
  };
}

function peakIndex(values: number[]) {
  let best = 0;
  values.forEach((v, i) => {
    if (Math.abs(v) > Math.abs(values[best])) best = i;
  });
  return best;
}

function isHorizontal(chart: ChartSpec, m: Model) {
  if (chart.chartType === "hbar") return true;
  if (chart.chartType !== "bar") return false;
  const count = m.labels.length;
  const longest = Math.max(...m.labels.map((l) => l.length));
  return count >= 16 || (count >= 10 && longest > 6) || (count >= 6 && longest > 8);
}

function heightFor(chart: ChartSpec, m: Model) {
  const count = chart.series.length;
  switch (chart.chartType) {
    case "pie":
      return 240;
    case "gauge":
      return 220;
    case "funnel":
      return Math.min(420, 60 + count * 44);
    default:
      if (isHorizontal(chart, m)) {
        const groups = m.stacked ? 1 : m.names.length;
        const row = groups > 1 ? 12 + groups * 12 : 30;
        return Math.min(900, Math.max(200, 56 + count * row));
      }
      return 280;
  }
}

function gradient(color: string, horizontal: boolean, from = 1, to = 0.55) {
  return {
    type: "linear",
    x: 0,
    y: 0,
    x2: horizontal ? 1 : 0,
    y2: horizontal ? 0 : 1,
    colorStops: horizontal
      ? [{ offset: 0, color: withAlpha(color, to) }, { offset: 1, color: withAlpha(color, from) }]
      : [{ offset: 0, color: withAlpha(color, from) }, { offset: 1, color: withAlpha(color, to) }],
  };
}

function withAlpha(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const tooltipBase = {
  confine: true,
  backgroundColor: TOOLTIP_BG,
  borderColor: BORDER,
  borderWidth: 1,
  padding: [8, 12],
  textStyle: { color: TEXT, fontSize: 12, fontFamily: FONT },
  extraCssText: "border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);",
};

function axisStyle(unit: string | null) {
  return {
    category: {
      axisLine: { lineStyle: { color: BORDER } },
      axisTick: { show: false },
      axisLabel: { color: MUTED, fontSize: 11, fontFamily: FONT, hideOverlap: true },
    },
    value: {
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: BORDER, type: "dashed" as const } },
      axisLabel: { color: FAINT, fontSize: 10, fontFamily: FONT, formatter: (v: number) => fmtCompact(v, unit) },
    },
  };
}

function refMarkLine(m: Model, horizontal: boolean, unit: string | null) {
  if (m.refs.length === 0) return undefined;
  return {
    silent: true,
    symbol: "none",
    animation: false,
    data: m.refs.map((r, i) => {
      const color = REF_COLORS[i % REF_COLORS.length];
      return {
        ...(horizontal ? { xAxis: r.value } : { yAxis: r.value }),
        name: r.label,
        lineStyle: { color, type: "dashed", width: 1.5 },
        label: {
          formatter: `${r.label} ${fmtCompact(r.value, unit)}`,
          position: horizontal ? "insideEndTop" : "insideEndTop",
          color,
          fontSize: 10,
          fontFamily: FONT,
        },
      };
    }),
  };
}

function legend(m: Model) {
  if (m.names.length < 2) return undefined;
  return {
    top: 0,
    right: 0,
    icon: "roundRect",
    itemWidth: 12,
    itemHeight: 8,
    textStyle: { color: MUTED, fontSize: 11, fontFamily: FONT },
    inactiveColor: "#5c5f66",
  };
}

function zoomFor(count: number, horizontal: boolean) {
  if (horizontal || count <= 24) return undefined;
  const end = Math.min(100, Math.round((24 / count) * 100));
  return [
    { type: "inside", start: 100 - end, end: 100 },
    {
      type: "slider",
      start: 100 - end,
      end: 100,
      height: 14,
      bottom: 4,
      borderColor: "transparent",
      backgroundColor: "rgba(255,255,255,.03)",
      fillerColor: "rgba(129,140,248,.18)",
      handleStyle: { color: SERIES_COLORS[0], borderColor: SERIES_COLORS[0] },
      moveHandleSize: 0,
      showDetail: false,
      dataBackground: { lineStyle: { color: BORDER }, areaStyle: { color: "rgba(255,255,255,.04)" } },
    },
  ];
}

function barOption(chart: ChartSpec, m: Model): EChartsCoreOption {
  const horizontal = isHorizontal(chart, m);
  const { unit } = chart;
  const axes = axisStyle(unit);
  const single = m.names.length === 1;
  const peak = peakIndex(m.rows.map((r) => r[0]));
  const lanes = m.stacked ? 1 : m.names.length;
  const showLabels = !m.stacked && (single ? m.labels.length <= 16 : m.labels.length * lanes <= 12);
  const zoom = zoomFor(m.labels.length, horizontal);

  const category = {
    type: "category",
    data: m.labels,
    ...axes.category,
    ...(horizontal
      ? { inverse: true, axisLabel: { ...axes.category.axisLabel, width: 120, overflow: "truncate" } }
      : { axisLabel: { ...axes.category.axisLabel, formatter: (v: string) => shortLabel(v, 8) } }),
  };
  const value = { type: "value", ...axes.value };

  return {
    color: SERIES_COLORS,
    grid: {
      left: 4,
      right: horizontal ? 48 : 12,
      top: m.names.length > 1 || m.refs.length ? 32 : 16,
      bottom: zoom ? 26 : 4,
      outerBoundsMode: "same",
      outerBoundsContain: "axisLabel",
    },
    legend: legend(m),
    tooltip: {
      ...tooltipBase,
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(255,255,255,.04)" } },
      valueFormatter: (v: number) => withUnit(v, unit),
    },
    dataZoom: zoom,
    xAxis: horizontal ? value : category,
    yAxis: horizontal ? category : value,
    series: m.names.map((name, s) => {
      const color = SERIES_COLORS[s % SERIES_COLORS.length];
      return {
        name,
        type: "bar",
        stack: m.stacked ? "total" : undefined,
        barMaxWidth: lanes > 1 ? 18 : 34,
        barGap: "18%",
        emphasis: { focus: single ? "none" : "series" },
        itemStyle: {
          color: gradient(color, horizontal),
          borderRadius: m.stacked && s < m.names.length - 1 ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
        },
        label: showLabels
          ? {
              show: true,
              position: horizontal ? "right" : "top",
              color: SECONDARY,
              fontSize: 10,
              fontFamily: FONT,
              formatter: ({ value: v }: { value: number }) => fmtCompact(v, unit),
            }
          : undefined,
        data: m.rows.map((row, i) =>
          single && i === peak && m.labels.length > 2
            ? { value: row[s], itemStyle: { color: gradient(PEAK_COLOR, horizontal, 1, 0.75) } }
            : row[s],
        ),
        markLine: s === 0 ? refMarkLine(m, horizontal, unit) : undefined,
      };
    }),
  };
}

function lineOption(chart: ChartSpec, m: Model, filled: boolean): EChartsCoreOption {
  const { unit } = chart;
  const axes = axisStyle(unit);
  const count = m.labels.length;
  const zoom = zoomFor(count, false);
  const dots = count <= 24;

  return {
    color: SERIES_COLORS,
    grid: {
      left: 4,
      right: 48,
      top: m.names.length > 1 || m.refs.length ? 32 : 16,
      bottom: zoom ? 26 : 4,
      outerBoundsMode: "same",
      outerBoundsContain: "axisLabel",
    },
    legend: legend(m),
    tooltip: {
      ...tooltipBase,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: FAINT, type: "dashed" } },
      valueFormatter: (v: number) => withUnit(v, unit),
    },
    dataZoom: zoom,
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: m.labels,
      ...axes.category,
      axisLabel: { ...axes.category.axisLabel, formatter: (v: string) => shortLabel(v, 8) },
    },
    yAxis: { type: "value", ...axes.value },
    series: m.names.map((name, s) => {
      const color = SERIES_COLORS[s % SERIES_COLORS.length];
      const main = s === 0;
      return {
        name,
        type: "line",
        smooth: 0.25,
        symbol: "circle",
        symbolSize: main ? 7 : 5,
        showSymbol: dots,
        lineStyle: { width: main ? 2.5 : 1.75, type: main ? "solid" : "dashed", color },
        itemStyle: { color, borderColor: PANEL, borderWidth: 2 },
        emphasis: { focus: "series" },
        areaStyle: main
          ? {
              color: {
                type: "linear",
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: withAlpha(color, filled ? 0.45 : 0.22) },
                  { offset: 1, color: withAlpha(color, 0) },
                ],
              },
            }
          : undefined,
        endLabel: main
          ? {
              show: true,
              color: TEXT,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: FONT,
              formatter: ({ value: v }: { value: number }) => fmtCompact(v, unit),
            }
          : undefined,
        data: m.rows.map((row) => row[s]),
        markLine: main ? refMarkLine(m, false, unit) : undefined,
      };
    }),
  };
}

function pieOption(chart: ChartSpec): EChartsCoreOption {
  const { unit, series } = chart;
  const total = series.reduce((sum, d) => sum + d.value, 0);
  const byName = new Map(series.map((d) => [d.label, d.value]));
  return {
    color: PALETTE,
    tooltip: {
      ...tooltipBase,
      trigger: "item",
      formatter: (p: { name: string; value: number; percent: number; marker: string }) =>
        `${p.marker}${p.name}<br/><b>${withUnit(p.value, unit)}</b> · ${p.percent.toFixed(1)}%`,
    },
    legend: {
      type: "scroll",
      orient: "vertical",
      right: 8,
      top: "middle",
      // 긴 항목도 차트 밖으로 나가지 않게 너비를 고정하고 넘치면 말줄임한다.
      width: "46%",
      textStyle: { color: SECONDARY, fontSize: 11, fontFamily: FONT, overflow: "truncate", width: 150 },
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 10,
      pageTextStyle: { color: FAINT },
      pageIconColor: MUTED,
      pageIconInactiveColor: BORDER,
      formatter: (name: string) => {
        const v = byName.get(name) ?? 0;
        const pct = total > 0 ? ((v / total) * 100).toFixed(0) : "0";
        return `${shortLabel(name, 12)}  ${fmtCompact(v, unit)} · ${pct}%`;
      },
    },
    series: [
      {
        type: "pie",
        radius: ["52%", "78%"],
        center: ["30%", "50%"],
        padAngle: 1.5,
        itemStyle: { borderRadius: 5, borderColor: PANEL, borderWidth: 2 },
        label: {
          show: true,
          position: "center",
          formatter: () => `{v|${fmtCompact(total, unit)}}\n{t|합계}`,
          rich: {
            v: { color: TEXT, fontSize: 18, fontWeight: 700, fontFamily: FONT, lineHeight: 24 },
            t: { color: FAINT, fontSize: 10, fontFamily: FONT },
          },
        },
        emphasis: {
          scale: true,
          scaleSize: 6,
          label: {
            formatter: (p: { name: string; percent: number }) => `{v|${p.percent.toFixed(0)}%}\n{t|${shortLabel(p.name, 8)}}`,
          },
        },
        labelLine: { show: false },
        data: series.map((d) => ({ name: d.label, value: d.value })),
      },
    ],
  };
}

function funnelOption(chart: ChartSpec): EChartsCoreOption {
  const { unit, series } = chart;
  const first = Math.max(...series.map((d) => d.value), 0);
  return {
    color: PALETTE,
    tooltip: {
      ...tooltipBase,
      trigger: "item",
      formatter: (p: { name: string; value: number; marker: string }) =>
        `${p.marker}${p.name}<br/><b>${withUnit(p.value, unit)}</b>${first ? ` · ${((p.value / first) * 100).toFixed(1)}%` : ""}`,
    },
    series: [
      {
        type: "funnel",
        left: "8%",
        right: "8%",
        top: 8,
        bottom: 8,
        minSize: "18%",
        sort: "descending",
        gap: 3,
        itemStyle: { borderWidth: 0, borderRadius: 4 },
        label: {
          show: true,
          position: "inside",
          color: "#fff",
          fontSize: 12,
          fontWeight: 600,
          fontFamily: FONT,
          formatter: (p: { name: string; value: number }) => `${p.name}  ${fmtCompact(p.value, unit)}`,
        },
        emphasis: { label: { fontSize: 13 } },
        data: series.map((d) => ({ name: d.label, value: d.value })),
      },
    ],
  };
}

function gaugeTarget(chart: ChartSpec) {
  const { series, unit } = chart;
  const value = series[0]?.value ?? 0;
  if (series[1]?.value && series[1].value > 0) return series[1].value;
  if (isPercent(unit)) return 100;
  const exp = Math.floor(Math.log10(Math.max(Math.abs(value), 1)));
  const base = 10 ** exp;
  return [1, 2, 2.5, 5, 10].map((k) => k * base).find((v) => v >= Math.abs(value)) ?? base * 10;
}

function gaugeOption(chart: ChartSpec): EChartsCoreOption {
  const { series, unit } = chart;
  const value = series[0]?.value ?? 0;
  const target = gaugeTarget(chart);
  const pct = target ? (Math.abs(value) / target) * 100 : 0;
  const color = pct >= 100 ? UP : pct >= 70 ? SERIES_COLORS[0] : REF_COLORS[0];
  return {
    series: [
      {
        type: "gauge",
        startAngle: 215,
        endAngle: -35,
        min: 0,
        max: target,
        radius: "92%",
        center: ["50%", "58%"],
        progress: { show: true, width: 14, roundCap: true, itemStyle: { color } },
        axisLine: { roundCap: true, lineStyle: { width: 14, color: [[1, BORDER]] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        anchor: { show: false },
        title: { show: true, offsetCenter: [0, "38%"], color: FAINT, fontSize: 11, fontFamily: FONT },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, "-2%"],
          formatter: () => `{v|${fmtCompact(value, unit)}}\n{t|/ ${withUnit(target, unit)} · ${pct.toFixed(0)}%}`,
          rich: {
            v: { color: TEXT, fontSize: 26, fontWeight: 700, fontFamily: FONT, lineHeight: 34 },
            t: { color: MUTED, fontSize: 11, fontFamily: FONT },
          },
        },
        data: [{ value: Math.min(Math.abs(value), target), name: series[0]?.label || "현재" }],
      },
    ],
  };
}

function buildOption(chart: ChartSpec, m: Model): EChartsCoreOption {
  const base = { animationDuration: 600, animationEasing: "cubicOut" as const, textStyle: { fontFamily: FONT } };
  switch (chart.chartType) {
    case "pie":
      return { ...base, ...pieOption(chart) };
    case "funnel":
      return { ...base, ...funnelOption(chart) };
    case "gauge":
      return { ...base, ...gaugeOption(chart) };
    case "line":
      return { ...base, ...lineOption(chart, m, false) };
    case "area":
      return { ...base, ...lineOption(chart, m, true) };
    default:
      return { ...base, ...barOption(chart, m) };
  }
}

function Delta({ from, to }: { from: number; to: number }) {
  if (from === 0) return null;
  const pct = ((to - from) / Math.abs(from)) * 100;
  return (
    <span className="tabular-nums" style={{ color: pct >= 0 ? UP : DOWN }}>
      {pct >= 0 ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

function Chip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px]"
      style={{ background: "var(--dc-main)", border: "1px solid var(--dc-border)" }}
    >
      <span style={{ color: "var(--dc-faint)" }}>{label}</span>
      <span className="inline-flex items-center gap-1.5 tabular-nums" style={{ color: "var(--dc-text)" }}>{children}</span>
    </span>
  );
}

function Summary({ chart, m }: { chart: ChartSpec; m: Model }) {
  const values = m.rows.map((row) => (m.stacked ? row.reduce((sum, v) => sum + v, 0) : row[0]));
  if (values.length < 2) return null;
  const percent = isPercent(chart.unit);
  const total = values.reduce((sum, v) => sum + v, 0);
  const peak = peakIndex(values);
  const trend = chart.chartType === "line" || chart.chartType === "area";
  const compare = m.stacked ? undefined : chart.compare?.[0];
  const compareTotal = compare ? m.rows.reduce((sum, row) => sum + row[1], 0) : 0;
  const unit = chart.unit ? ` ${chart.unit}` : "";

  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      <Chip label={percent ? "평균" : "합계"}>
        {fmtNum(percent ? total / values.length : total)}{unit}
      </Chip>
      <Chip label="최고">
        <span style={{ color: "var(--dc-muted)" }}>{shortLabel(m.labels[peak], 10)}</span>
        {fmtNum(values[peak])}
      </Chip>
      {trend && (
        <Chip label={`${shortLabel(m.labels[0], 8)} → ${shortLabel(m.labels[values.length - 1], 8)}`}>
          <Delta from={values[0]} to={values[values.length - 1]} />
        </Chip>
      )}
      {compare && compareTotal !== 0 && (
        <Chip label={`vs ${shortLabel(compare.name, 10)}`}>
          <Delta from={compareTotal} to={total} />
        </Chip>
      )}
    </div>
  );
}

function ChartView({ chart }: { chart: ChartSpec }) {
  const ref = useRef<HTMLDivElement>(null);
  const { chartType, title, unit, series } = chart;
  const m = toModel(chart);
  const height = heightFor(chart, m);
  const horizontal = isHorizontal(chart, m);

  useEffect(() => {
    const el = ref.current;
    if (!el || chart.series.length === 0) return;
    let disposed = false;
    let instance: { setOption: (o: EChartsCoreOption) => void; resize: () => void; dispose: () => void } | null = null;
    let observer: ResizeObserver | null = null;

    void import("@/lib/echarts").then(({ default: echarts }) => {
      if (disposed) return;
      const inst = echarts.init(el, null, { renderer: "svg" });
      inst.setOption(buildOption(chart, toModel(chart)));
      instance = inst;
      observer = new ResizeObserver(() => inst.resize());
      observer.observe(el);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      instance?.dispose();
    };
  }, [chart]);

  if (series.length === 0) return null;
  const wide = series.length >= 16 && !horizontal && chartType !== "pie";

  return (
    <figure
      className={`my-2 w-full rounded-xl p-3 ${
        wide ? "max-w-full" : horizontal ? "max-w-[min(100%,48rem)]" : "max-w-[min(100%,38rem)]"
      }`}
      style={{ background: "var(--dc-sidebar)", border: "1px solid var(--dc-border)" }}
    >
      <figcaption className="mb-2 flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-semibold" style={{ color: "var(--dc-text)" }}>{title}</span>
        {unit && <span className="shrink-0 text-xs" style={{ color: "var(--dc-faint)" }}>단위: {unit}</span>}
      </figcaption>
      {chartType !== "gauge" && chartType !== "funnel" && <Summary chart={chart} m={m} />}
      <div ref={ref} style={{ width: "100%", height }} role="img" aria-label={title} />
    </figure>
  );
}

export default memo(ChartView);
