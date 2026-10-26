import { create } from "zustand";
import { sidecarRequest } from "@/lib/tauri";

export type InboxItem = {
  id?: string;
  파일명?: string;
  올린시각?: string;
  쪽수?: number;
  추출?: string;
};

export type DocVersion = {
  버전?: number;
  파일명?: string;
  올린시각?: string;
  추출?: string;
};

export type DocItem = {
  문서id?: string;
  문서명?: string;
  버전?: DocVersion[];
};

export type FilesPayload = {
  미분류: InboxItem[];
  문서: DocItem[];
};

type FilesState = {
  channelId: string;
  inbox: InboxItem[];
  docs: DocItem[];
  loading: boolean;
  error: string;
  bind: (channelId: string) => void;
  reload: () => Promise<void>;
  upload: (file: File) => Promise<void>;
  remove: (itemId: string) => Promise<void>;
  open: (itemId: string, filename?: string) => Promise<string>;
};

function unwrap(result: unknown): FilesPayload {
  if (!result || typeof result !== "object") return { 미분류: [], 문서: [] };
  const raw =
    "data" in result && result.data && typeof result.data === "object"
      ? (result.data as Record<string, unknown>)
      : (result as Record<string, unknown>);
  return {
    미분류: Array.isArray(raw.미분류) ? (raw.미분류 as InboxItem[]) : [],
    문서: Array.isArray(raw.문서) ? (raw.문서 as DocItem[]) : [],
  };
}

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export const useFilesStore = create<FilesState>((set, get) => ({
  channelId: "",
  inbox: [],
  docs: [],
  loading: false,
  error: "",

  bind: (channelId) => {
    if (get().channelId === channelId) return;
    set({ channelId, inbox: [], docs: [], error: "" });
    if (channelId) void get().reload();
  },

  reload: async () => {
    const { channelId } = get();
    if (!channelId) return;
    const first = get().inbox.length === 0 && get().docs.length === 0;
    set({ loading: first, error: "" });
    try {
      const payload = unwrap(await sidecarRequest("listChannelFiles", { channelId }));
      set({ inbox: payload.미분류, docs: payload.문서, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  upload: async (file) => {
    const { channelId } = get();
    if (!channelId) throw new Error("문서함 채널이 아닙니다.");
    if (!file.name.toLowerCase().endsWith(".pdf")) throw new Error("PDF만 올릴 수 있습니다.");
    set({ loading: true, error: "" });
    try {
      await sidecarRequest("uploadChannelFile", {
        channelId,
        filename: file.name,
        bytesBase64: await fileToBase64(file),
      });
      await get().reload();
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  open: async (itemId, filename) => {
    const { channelId } = get();
    if (!channelId) throw new Error("문서함 채널이 아닙니다.");
    const saved = await sidecarRequest<{ path?: string }>("openChannelFile", {
      channelId,
      itemId,
      filename,
    });
    const filePath = String(saved?.path || "").trim();
    if (!filePath) throw new Error("파일을 받지 못했습니다.");
    return filePath;
  },

  remove: async (itemId) => {
    const { channelId } = get();
    if (!channelId) return;
    set({ loading: true, error: "" });
    try {
      await sidecarRequest("deleteChannelFile", { channelId, itemId });
      await get().reload();
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));
