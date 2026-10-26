"use client";

import { useEffect } from "react";
import { BarChart3, Loader2, RotateCcw } from "lucide-react";
import { useAssistantStore } from "@/store/assistantStore";
import type { AdapterUsage, UsageWindow } from "@/types/assistant";

function fmtInt(n: number) {
  return new Intl.NumberFormat("ko-KR").format(Math.round(n || 0));
}

function fmtCost(n: number) {
  return `$${(n || 0).toFixed(4)}`;
}

function windowName(w: UsageWindow) {
  if (w.windowMinutes === 300) return "5시간 한도";
  if (w.windowMinutes === 10080) return "주간 한도";
  if (w.windowMinutes && w.windowMinutes % 60 === 0) return `${w.windowMinutes / 60}시간 한도`;
  return "사용 한도";
}

function fmtReset(ms: number | null) {
  if (!ms) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return "곧 초기화";
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days}일 후 초기화`;
  if (hours >= 1) return `${hours}시간 후 초기화`;
  return `${Math.max(1, Math.floor(diff / 60_000))}분 후 초기화`;
}

function fmtLastUsed(iso: string | null) {
  if (!iso) return "사용 기록 없음";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "사용 기록 없음";
  return `${d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" })} 마지막 사용`;
}

function QuotaBar({ w }: { w: UsageWindow }) {
  const pct = Math.max(0, Math.min(100, w.usedPercent ?? 0));
  const reset = fmtReset(w.resetsAt);
  const danger = pct >= 90;
  const warn = pct >= 70;
  const color = danger ? "var(--dc-danger)" : warn ? "#e6a23c" : "var(--dc-blurple)";
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span style={{ color: "var(--dc-secondary)" }}>{windowName(w)}</span>
        <span style={{ color: "var(--dc-text)", fontVariantNumeric: "tabular-nums" }}>
          {w.usedPercent ?? 0}%{reset ? <span style={{ color: "var(--dc-muted)" }}> · {reset}</span> : null}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--dc-bg)" }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px]" style={{ color: "var(--dc-muted)" }}>{label}</p>
      <p className="text-sm font-semibold" style={{ color: "var(--dc-text)", fontVariantNumeric: "tabular-nums" }}>{value}</p>
    </div>
  );
}

function AdapterCard({ item, onReset }: { item: AdapterUsage; onReset: () => void }) {
  const { app, plan } = item;
  const hasCost = (app.costUsd ?? 0) > 0;
  const statusText = !item.installed ? "설치 안 됨" : !item.loggedIn ? "로그인 필요" : item.account ?? "연결됨";
  const statusColor = item.loggedIn ? "var(--dc-online)" : "var(--dc-danger)";

  return (
    <div className="rounded-md p-3.5" style={{ background: "var(--dc-bg)", border: "1px solid var(--dc-border)" }}>
      <div className="mb-3 flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--dc-text)" }}>{item.label}</p>
          <p className="mt-0.5 truncate text-xs" style={{ color: statusColor }}>{statusText}</p>
        </div>
        <button
          onClick={onReset}
          title="이 계정의 앱 누적 사용량 초기화"
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px]"
          style={{ border: "1px solid var(--dc-border)", color: "var(--dc-muted)" }}
        >
          <RotateCcw size={11} />
          초기화
        </button>
      </div>

      {plan && (plan.primary || plan.secondary) && (
        <>
          <div className="mb-1 text-[11px]" style={{ color: "var(--dc-muted)" }}>계정 요금제 한도</div>
          <div className="mb-3 space-y-2.5">
            {plan.primary && <QuotaBar w={plan.primary} />}
            {plan.secondary && <QuotaBar w={plan.secondary} />}
          </div>
        </>
      )}

      <div className="mb-1 text-[11px]" style={{ color: "var(--dc-muted)" }}>이 앱에서의 누적 사용량</div>
      <div className={`grid ${hasCost ? "grid-cols-4" : "grid-cols-3"} gap-3`}>
        <Stat label="대화 수" value={fmtInt(app.messages)} />
        <Stat label="입력 토큰" value={fmtInt(app.inputTokens)} />
        <Stat label="출력 토큰" value={fmtInt(app.outputTokens)} />
        {hasCost && <Stat label="비용" value={fmtCost(app.costUsd)} />}
      </div>
      <p className="mt-2 text-[11px]" style={{ color: "var(--dc-muted)" }}>{fmtLastUsed(app.lastUsedAt)}</p>
    </div>
  );
}

export default function UsagePanel() {
  const { usage, usageLoading, fetchUsage, resetUsage } = useAssistantStore();

  useEffect(() => {
    void fetchUsage();
  }, [fetchUsage]);

  return (
    <section className="rounded-lg p-4" style={{ background: "var(--dc-sidebar)", border: "1px solid var(--dc-border)" }}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 size={15} style={{ color: "var(--dc-muted)" }} />
          <h3 className="text-sm font-semibold" style={{ color: "var(--dc-text)" }}>계정별 사용량</h3>
        </div>
        <button
          onClick={() => void fetchUsage()}
          disabled={usageLoading}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs disabled:opacity-50"
          style={{ border: "1px solid var(--dc-border)", color: "var(--dc-muted)" }}
        >
          {usageLoading ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
          새로고침
        </button>
      </div>
      <p className="mb-3 text-xs" style={{ color: "var(--dc-muted)" }}>
        요금제 한도(%)는 Claude 계정 전체 기준이고, 토큰·비용은 이 앱에서 쌓인 값입니다.
      </p>

      {usage.length === 0 ? (
        <p className="rounded-md p-3.5 text-xs" style={{ background: "var(--dc-bg)", color: "var(--dc-muted)", border: "1px solid var(--dc-border)" }}>
          {usageLoading ? "사용량을 불러오는 중..." : "표시할 사용량이 없습니다."}
        </p>
      ) : (
        <div className="space-y-3">
          {usage.map((item) => (
            <AdapterCard key={item.id} item={item} onReset={() => void resetUsage(item.id)} />
          ))}
        </div>
      )}
    </section>
  );
}
