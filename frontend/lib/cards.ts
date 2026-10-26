import type { CardItem, CardsSpec } from "@/types/assistant";

function cardKey(item: CardItem) {
  const sku = item.badge?.trim().toLowerCase();
  if (sku) return `sku:${sku}`;
  return `title:${item.title.trim().toLowerCase()}`;
}

function richness(item: CardItem) {
  return item.fields.length * 10 + (item.image ? 2 : 0) + (item.subtitle ? 1 : 0);
}

function prefer(current: CardItem, incoming: CardItem): CardItem {
  const richer = richness(incoming) >= richness(current) ? incoming : current;
  const leaner = richer === incoming ? current : incoming;
  return {
    title: richer.title,
    subtitle: richer.subtitle || leaner.subtitle,
    image: richer.image || leaner.image,
    badge: richer.badge || leaner.badge,
    fields: richer.fields.length >= leaner.fields.length ? richer.fields : leaner.fields,
  };
}

/** 같은 제품(SKU/이름)이 검색·상세로 두 번 오면 더 자세한 쪽만 남긴다. */
export function collapseCardBlocks(blocks: CardsSpec[]): CardsSpec[] {
  if (blocks.length <= 1) {
    const only = blocks[0];
    if (!only || only.items.length <= 1) return blocks;
  }

  const items = new Map<string, CardItem>();
  const order: string[] = [];
  for (const block of blocks) {
    for (const item of block.items) {
      const key = cardKey(item);
      const prev = items.get(key);
      if (!prev) {
        items.set(key, item);
        order.push(key);
      } else {
        items.set(key, prefer(prev, item));
      }
    }
  }

  const merged = order.map((key) => items.get(key)!);
  const first = blocks[0];
  return [{ id: first?.id ?? "cards", title: first?.title ?? null, items: merged }];
}
