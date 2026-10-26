"use client";

import { memo, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CalendarEvent, CalendarSpec, CalendarTone } from "@/types/assistant";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const TONE_COLOR: Record<CalendarTone, string> = {
  info: "#818cf8",
  ok: "#34d399",
  warn: "#fbbf24",
  danger: "#f87171",
};
const TONE_RANK: Record<CalendarTone, number> = {
  danger: 4,
  warn: 3,
  ok: 2,
  info: 1,
};

function toEokMan(amount: number) {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.round(Math.abs(amount));
  const eok = Math.floor(abs / 100_000_000);
  const man = Math.floor((abs % 100_000_000) / 10_000);
  if (eok && man) return `${sign}${eok.toLocaleString("ko-KR")}억 ${man.toLocaleString("ko-KR")}만`;
  if (eok) return `${sign}${eok.toLocaleString("ko-KR")}억`;
  if (man) return `${sign}${man.toLocaleString("ko-KR")}만`;
  return `${sign}${abs.toLocaleString("ko-KR")}원`;
}

function wonText(value: string) {
  return value
    .replace(/(-?[\d,.]+)\s*백만\s*원?/g, (match, raw: string) => {
      const n = Number(raw.replace(/,/g, ""));
      return Number.isFinite(n) ? toEokMan(n * 1_000_000) : match;
    })
    .replace(/(-?[\d,]+)\s*원/g, (match, raw: string) => {
      const n = Number(raw.replace(/,/g, ""));
      return Number.isFinite(n) && Math.abs(n) >= 10_000 ? toEokMan(n) : match;
    });
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function toYmd(year: number, month: number, day: number) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function todayYmd() {
  const now = new Date();
  return toYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function parseYmd(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function monthLabel(year: number, month: number) {
  return `${year}년 ${month}월`;
}

function monthKeys(events: CalendarEvent[]) {
  return [...new Set(events.map((event) => event.date.slice(0, 7)))].sort();
}

function monthFromKey(key: string) {
  const parsed = parseYmd(`${key}-01`);
  return parsed ? { year: parsed.year, month: parsed.month } : null;
}

function defaultMonth(events: CalendarEvent[]) {
  const today = todayYmd();
  const keys = monthKeys(events);
  if (keys.includes(today.slice(0, 7))) return monthFromKey(today.slice(0, 7)) ?? { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = event.date.slice(0, 7);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return monthFromKey(best ?? today.slice(0, 7)) ?? { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
}

function dayTone(events: CalendarEvent[]): CalendarTone {
  return events.reduce<CalendarTone>((best, event) => (
    TONE_RANK[event.tone] > TONE_RANK[best] ? event.tone : best
  ), "info");
}

function CalendarView({ calendar }: { calendar: CalendarSpec }) {
  const events = useMemo(
    () => calendar.events.filter((event) => parseYmd(event.date)),
    [calendar.events],
  );
  const [cursor, setCursor] = useState(() => defaultMonth(events));
  const [selected, setSelected] = useState<string | null>(null);
  const today = todayYmd();

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const list = map.get(event.date) ?? [];
      list.push(event);
      map.set(event.date, list);
    }
    return map;
  }, [events]);

  const cells = useMemo(() => {
    const first = new Date(cursor.year, cursor.month - 1, 1).getDay();
    const last = new Date(cursor.year, cursor.month, 0).getDate();
    const out: Array<{ key: string; date: string | null; day: number | null }> = [];
    for (let i = 0; i < first; i += 1) out.push({ key: `pad-${i}`, date: null, day: null });
    for (let day = 1; day <= last; day += 1) {
      const date = toYmd(cursor.year, cursor.month, day);
      out.push({ key: date, date, day });
    }
    while (out.length % 7 !== 0) out.push({ key: `tail-${out.length}`, date: null, day: null });
    return out;
  }, [cursor]);

  const monthKey = `${cursor.year}-${pad(cursor.month)}`;
  const monthEvents = events
    .filter((event) => event.date.startsWith(monthKey))
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const shown = selected ? monthEvents.filter((event) => event.date === selected) : monthEvents;
  const months = monthKeys(events);
  const prevMonth = months.filter((key) => key < monthKey).at(-1);
  const nextMonth = months.find((key) => key > monthKey);

  if (events.length === 0) return null;

  return (
    <figure
      className="my-2 w-full max-w-[min(100%,42rem)] rounded-lg p-3"
      style={{ background: "var(--dc-sidebar)", border: "1px solid var(--dc-border)" }}
    >
      <figcaption className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-xs font-semibold" style={{ color: "var(--dc-text)" }}>
          {wonText(calendar.title)}
        </span>
        <span className="shrink-0 text-[11px]" style={{ color: "var(--dc-faint)" }}>
          {events.length}건
        </span>
      </figcaption>

      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="이전 달"
          disabled={!prevMonth}
          onClick={() => {
            const next = prevMonth ? monthFromKey(prevMonth) : null;
            if (!next) return;
            setCursor(next);
            setSelected(null);
          }}
          className="rounded-md p-1 disabled:opacity-30"
          style={{ color: "var(--dc-muted)" }}
        >
          <ChevronLeft size={16} />
        </button>
        <p className="text-sm font-semibold" style={{ color: "var(--dc-text)" }}>
          {monthLabel(cursor.year, cursor.month)}
        </p>
        <button
          type="button"
          aria-label="다음 달"
          disabled={!nextMonth}
          onClick={() => {
            const next = nextMonth ? monthFromKey(nextMonth) : null;
            if (!next) return;
            setCursor(next);
            setSelected(null);
          }}
          className="rounded-md p-1 disabled:opacity-30"
          style={{ color: "var(--dc-muted)" }}
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-x-1 gap-y-1 text-center">
        {WEEKDAYS.map((label, index) => (
          <div
            key={label}
            className="pb-1 text-[11px] font-medium"
            style={{ color: index === 0 ? "#f87171" : "var(--dc-faint)" }}
          >
            {label}
          </div>
        ))}
        {cells.map((cell) => {
          if (!cell.date || cell.day == null) {
            return <div key={cell.key} className="h-11" />;
          }
          const dayEvents = byDate.get(cell.date) ?? [];
          const isToday = cell.date === today;
          const isSelected = cell.date === selected;
          const tone = dayEvents.length > 0 ? dayTone(dayEvents) : "info";
          const weekday = new Date(cursor.year, cursor.month - 1, cell.day).getDay();
          return (
            <button
              key={cell.key}
              type="button"
              onClick={() => setSelected((cur) => (cur === cell.date ? null : cell.date))}
              className="relative flex h-11 w-full flex-col items-center justify-center rounded-md text-sm"
              style={{
                color: weekday === 0 ? "#f87171" : "var(--dc-secondary)",
                background: isSelected
                  ? "rgba(88,101,242,0.22)"
                  : isToday
                    ? "rgba(88,101,242,0.12)"
                    : "transparent",
                boxShadow: isToday && !isSelected ? "inset 0 0 0 1px rgba(88,101,242,0.55)" : undefined,
              }}
            >
              {cell.day}
              {dayEvents.length > 0 && (
                <span className="absolute bottom-0.5 flex gap-0.5">
                  {dayEvents.slice(0, 3).map((event, index) => (
                    <i
                      key={`${event.title}-${index}`}
                      className="block h-1 w-1 rounded-full"
                      style={{ background: TONE_COLOR[index === 0 ? tone : event.tone] }}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <ul className="mt-3 max-h-48 space-y-1.5 overflow-y-auto pr-1">
        {shown.length === 0 ? (
          <li className="py-2 text-center text-[11px]" style={{ color: "var(--dc-faint)" }}>
            이 달에 일정이 없습니다.
          </li>
        ) : (
          shown.map((event, index) => (
            <li
              key={`${event.date}-${event.title}-${index}`}
              className="rounded-md px-2 py-1.5"
              style={{ background: "var(--dc-input)", borderLeft: `3px solid ${TONE_COLOR[event.tone]}` }}
            >
              <p className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="font-semibold" style={{ color: "var(--dc-text)" }}>{wonText(event.title)}</span>
                <span className="shrink-0 tabular-nums" style={{ color: "var(--dc-faint)" }}>{event.date.slice(5)}</span>
              </p>
              {event.subtitle && (
                <p className="mt-0.5 truncate text-[11px]" style={{ color: "var(--dc-muted)" }}>{wonText(event.subtitle)}</p>
              )}
            </li>
          ))
        )}
      </ul>
    </figure>
  );
}

export default memo(CalendarView);
