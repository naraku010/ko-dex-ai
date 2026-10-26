"use client";

import { memo, useState } from "react";
import { ImageOff } from "lucide-react";
import type { CardItem, CardsSpec } from "@/types/assistant";

function CardImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className="flex aspect-square w-full items-center justify-center"
        style={{ background: "var(--dc-bg)", color: "var(--dc-faint)" }}
      >
        <ImageOff size={18} />
      </div>
    );
  }

  return (
    // 채널 서버가 주는 임의 URL이라 next/image 대신 평범한 img를 쓴다.
    <img
      src={src}
      alt={alt}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className="aspect-square w-full object-cover"
      style={{ background: "var(--dc-bg)" }}
    />
  );
}

function Card({ item }: { item: CardItem }) {
  return (
    <div
      className="overflow-hidden rounded-lg"
      style={{ background: "var(--dc-sidebar)", border: "1px solid var(--dc-border)" }}
    >
      <div className="relative">
        {item.image ? (
          <CardImage src={item.image} alt={item.title} />
        ) : (
          <div className="aspect-square w-full" style={{ background: "var(--dc-bg)" }} />
        )}
        {item.badge && (
          <span
            className="absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold"
            style={{ background: "var(--dc-blurple)", color: "#fff" }}
          >
            {item.badge}
          </span>
        )}
      </div>

      <div className="space-y-1 p-2.5">
        <p className="truncate text-xs font-semibold" style={{ color: "var(--dc-text)" }} title={item.title}>
          {item.title}
        </p>
        {item.subtitle && (
          <p className="truncate text-[11px]" style={{ color: "var(--dc-muted)" }} title={item.subtitle}>
            {item.subtitle}
          </p>
        )}
        {item.fields.length > 0 && (
          <dl className="space-y-0.5 pt-0.5">
            {item.fields.map((field, index) => (
              <div key={`${field.label}-${index}`} className="flex items-baseline justify-between gap-2 text-[11px]">
                <dt className="shrink-0" style={{ color: "var(--dc-faint)" }}>
                  {field.label}
                </dt>
                <dd className="truncate text-right" style={{ color: "var(--dc-secondary)" }} title={field.value}>
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

function CardsView({ cards }: { cards: CardsSpec }) {
  if (cards.items.length === 0) return null;

  return (
    <div
      className="rounded-lg p-3"
      style={{ background: "var(--dc-input)", border: "1px solid var(--dc-border)" }}
    >
      {cards.title && (
        <p className="mb-2.5 text-xs font-semibold" style={{ color: "var(--dc-text)" }}>
          {cards.title}
        </p>
      )}
      <div
        className={
          cards.items.length === 1
            ? "max-w-[18rem]"
            : "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
        }
      >
        {cards.items.map((item, index) => (
          <Card key={`${item.badge || item.title}-${index}`} item={item} />
        ))}
      </div>
    </div>
  );
}

export default memo(CardsView);
