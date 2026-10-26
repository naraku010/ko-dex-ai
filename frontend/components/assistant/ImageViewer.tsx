"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X, ZoomIn, ZoomOut } from "lucide-react";

const MIN = 0.25;
const MAX = 8;
const STEP = 1.25;

type View = { scale: number; x: number; y: number };

const clamp = (value: number) => Math.min(MAX, Math.max(MIN, value));

export default function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  // (cx, cy)는 화면 중앙 기준 좌표다. 그 점이 제자리에 남도록 배율을 바꾼다.
  const zoomAt = useCallback((factor: number, cx = 0, cy = 0) => {
    setView((prev) => {
      const scale = clamp(prev.scale * factor);
      const ratio = scale / prev.scale;
      return { scale, x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio };
    });
  }, []);

  const reset = useCallback(() => setView({ scale: 1, x: 0, y: 0 }), []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const cx = event.clientX - rect.left - rect.width / 2;
      const cy = event.clientY - rect.top - rect.height / 2;
      zoomAt(event.deltaY < 0 ? STEP : 1 / STEP, cx, cy);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "+" || event.key === "=") zoomAt(STEP);
      else if (event.key === "-") zoomAt(1 / STEP);
      else if (event.key === "0") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, reset, zoomAt]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) current.moved = true;
    current.x = event.clientX;
    current.y = event.clientY;
    setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    drag.current = null;
    setDragging(false);
    if (!current || current.moved) return;
    // 이미지 밖 빈 곳을 그냥 누르면 닫는다.
    if (event.target === event.currentTarget) onClose();
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (view.scale !== 1) {
      reset();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    zoomAt(2.5, event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
  };

  const button = "flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-white/15";

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col" style={{ background: "rgba(0,0,0,0.85)" }} role="dialog" aria-label={alt}>
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 px-4 text-white">
        <p className="min-w-0 truncate text-sm opacity-80">{alt}</p>
        <div className="flex items-center gap-1">
          <button type="button" className={button} onClick={() => zoomAt(1 / STEP)} title="축소 (-)">
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            className="h-8 min-w-14 rounded-md px-2 text-xs tabular-nums hover:bg-white/15"
            onClick={reset}
            title="화면에 맞춤 (0)"
          >
            {Math.round(view.scale * 100)}%
          </button>
          <button type="button" className={button} onClick={() => zoomAt(STEP)} title="확대 (+)">
            <ZoomIn size={16} />
          </button>
          <button type="button" className={button} onClick={reset} title="화면에 맞춤 (0)">
            <Maximize2 size={15} />
          </button>
          <button type="button" className={`${button} ml-2`} onClick={onClose} title="닫기 (Esc)">
            <X size={18} />
          </button>
        </div>
      </div>
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden p-6"
        style={{ cursor: dragging ? "grabbing" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        onDoubleClick={onDoubleClick}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- 로컬 data URL이라 next/image를 쓸 수 없다 */}
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="pointer-events-none max-h-full max-w-full rounded-md object-contain shadow-2xl"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transition: dragging ? "none" : "transform 80ms ease-out",
          }}
        />
      </div>
      <p className="pb-3 text-center text-[11px] text-white/50">휠로 확대·축소 · 끌어서 이동 · 더블클릭으로 확대/맞춤 · Esc로 닫기</p>
    </div>,
    document.body,
  );
}
