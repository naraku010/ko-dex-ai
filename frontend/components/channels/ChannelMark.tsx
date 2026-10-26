"use client";

import { Cog, Database, Factory, Files, ShoppingBag, type LucideIcon } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  files: Files,
  database: Database,
  factory: Factory,
  shop: ShoppingBag,
  cog: Cog,
};

export function ChannelIcon({ icon, size = 18 }: { icon?: string | null; size?: number }) {
  const Icon = ICONS[icon || ""] ?? Cog;
  return <Icon size={size} />;
}

export function channelTypeLabel(type?: string | null) {
  return type === "files" ? "파일 채널" : "조회 채널";
}

export function isFilesChannel(channel?: { id?: string | null; type?: string | null; icon?: string | null } | null) {
  return channel?.type === "files" || channel?.id === "files" || channel?.icon === "files";
}
