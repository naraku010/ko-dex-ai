"use client";

import { Calendar } from "lucide-react";

/** 날짜가 바뀌는 메시지 앞에 놓는 구분선. 예: 2026년 10월 6일 화요일 */
export default function DateDivider({ iso }: { iso: string | undefined }) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const label = date.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  return (
    <div className="flex justify-center px-4 py-3">
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"
        style={{ background: "var(--dc-sidebar)", color: "var(--dc-muted)", border: "1px solid var(--dc-border)" }}
      >
        <Calendar size={12} />
        {label}
      </span>
    </div>
  );
}

/** 같은 날인지 비교하는 키. 시각이 없으면 구분선을 그리지 않는다. */
export function dayKey(iso: string | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
