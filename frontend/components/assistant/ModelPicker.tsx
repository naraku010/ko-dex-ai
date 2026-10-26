"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, Sparkles } from "lucide-react";
import type { AdapterInfo, ModelOption } from "@/types/assistant";

interface MenuItem {
  id: string;
  label: string;
  hint?: string;
}

const HINTS: Record<string, string> = {
  default: "CLI 기본값 · 계정 권장 모델을 그대로 씁니다",
  sonnet: "속도와 정확도의 균형 · 일상 작업에 권장",
  opus: "가장 정확 · 느리지만 어려운 질문에 강함",
  fable: "최신 모델 · 요금제에 따라 사용하지 못할 수 있음",
  haiku: "빠르고 경제적 · 짧은 조회에 적합",
  "gpt-5.6-sol": "복잡한 코딩·분석에 강함",
  "gpt-5.6-terra": "성능과 비용의 균형 · 일상 작업에 권장",
  "gpt-5.6-luna": "빠르고 경제적 · 반복 작업용",
  "gpt-5.5": "이전 세대 검증된 모델 · 일반 작업용",
  "gpt-5.4": "일상 코딩·조회에 충분한 성능",
  "gpt-5.4-mini": "작고 빠름 · 단순한 작업용",
  "gpt-5.3-codex-spark": "초고속 코딩 프리뷰 · Pro 계정 전용",
  "gpt-6-astra": "가장 어려운 복합 작업 · 계정별 순차 제공",
};

const FAMILIES: [RegExp, string][] = [
  [/sonnet/i, "속도와 정확도의 균형 · 일상 작업에 권장"],
  [/opus/i, "가장 정확 · 느리지만 어려운 질문에 강함"],
  [/fable/i, "최신 모델 · 요금제에 따라 사용하지 못할 수 있음"],
  [/haiku/i, "빠르고 경제적 · 짧은 조회에 적합"],
  [/sol/i, "복잡한 코딩·분석에 강함"],
  [/terra/i, "성능과 비용의 균형 · 일상 작업에 권장"],
  [/luna/i, "빠르고 경제적 · 반복 작업용"],
  [/spark/i, "초고속 응답 · 일부 계정만 사용 가능"],
  [/astra/i, "가장 어려운 복합 작업용"],
  [/mini/i, "작고 빠름 · 단순한 작업용"],
];

const CLAUDE_ALIASES = new Set(["sonnet", "opus", "fable", "haiku"]);

function isCurrentModel(id: string) {
  const key = id.trim().toLowerCase();
  if (!key) return false;
  if (key === "default" || key === "sonnet" || key === "opus" || key === "fable" || key === "haiku") return true;
  if (/-\d{8}$/.test(key)) return false;
  if (/claude-3\b/.test(key)) return false;
  if (/gpt-5\.[0-5](?!\d)/.test(key) && !/spark/.test(key)) return false;
  if (/gpt-4\b|o1\b|o3\b|o4\b/.test(key)) return false;
  return true;
}

function koreanHint(id: string, hint?: string) {
  if (hint && /[가-힣]/.test(hint)) return hint;
  const key = id.trim().toLowerCase();
  if (HINTS[key]) return HINTS[key];
  const family = FAMILIES.find(([test]) => test.test(key));
  if (family) return family[1];
  return "이 계정의 CLI에서 가져온 모델";
}

function MenuPicker({
  items,
  selected,
  disabled,
  title,
  icon,
  onSelect,
}: {
  items: MenuItem[];
  selected: string;
  disabled?: boolean;
  title: string;
  icon: React.ReactNode;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (items.length === 0) return null;
  const current = items.find((m) => m.id === selected) ?? items[0];

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
        style={{ color: "var(--dc-muted)" }}
        title={disabled ? "응답 중에는 바꿀 수 없습니다" : title}
      >
        {icon}
        {current.label}
        <ChevronDown size={12} />
      </button>

      {open && (
        <div
          className="absolute right-0 z-30 mt-1.5 w-64 overflow-hidden rounded-md py-1.5 shadow-xl"
          style={{ background: "var(--dc-sidebar)", border: "1px solid var(--dc-border)" }}
        >
          {items.map((item) => {
            const isSelected = item.id === current.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setOpen(false);
                  if (!isSelected) onSelect(item.id);
                }}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-white/5"
              >
                <Check size={13} className="mt-0.5 shrink-0" style={{ color: isSelected ? "var(--dc-blurple)" : "transparent" }} />
                <span className="min-w-0">
                  <span className="block text-xs font-medium" style={{ color: "var(--dc-text)" }}>{item.label}</span>
                  <span className="block text-[11px] leading-snug" style={{ color: "var(--dc-muted)" }}>
                    {koreanHint(item.id, item.hint)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ModelPicker({
  models,
  selected,
  disabled,
  onSelect,
}: {
  models: ModelOption[];
  selected: string;
  disabled?: boolean;
  onSelect: (model: string) => void;
}) {
  const hasAlias = new Set(models.map((m) => m.id.toLowerCase()).filter((id) => CLAUDE_ALIASES.has(id)));
  const current = models.filter((m) => {
    if (!isCurrentModel(m.id)) return false;
    const key = m.id.toLowerCase();
    if (CLAUDE_ALIASES.has(key)) return true;
    const family = [...CLAUDE_ALIASES].find((alias) => key.includes(alias));
    return !family || !hasAlias.has(family);
  });
  const key = selected.toLowerCase();
  const picked =
    current.find((m) => m.id.toLowerCase() === key) ??
    (CLAUDE_ALIASES.has(key) ? current.find((m) => m.id.toLowerCase().includes(key)) : undefined) ??
    current[0];
  return (
    <MenuPicker
      items={current}
      selected={picked?.id ?? selected}
      disabled={disabled}
      title="응답에 사용할 모델"
      icon={<Cpu size={13} />}
      onSelect={onSelect}
    />
  );
}

export function AdapterPicker({
  adapters,
  selected,
  disabled,
  onSelect,
}: {
  adapters: AdapterInfo[];
  selected: string;
  disabled?: boolean;
  onSelect: (adapterId: string) => void;
}) {
  return (
    <MenuPicker
      items={adapters.map((a) => ({
        id: a.id,
        label: a.label,
        hint: a.ready
          ? a.kind === "api" ? "API 키 연결됨" : "로그인됨 · 사용 가능"
          : a.kind === "api" ? "API 키 필요" : "준비되지 않음",
      }))}
      selected={selected}
      disabled={disabled}
      title="사용할 연결"
      icon={<Sparkles size={13} />}
      onSelect={onSelect}
    />
  );
}
