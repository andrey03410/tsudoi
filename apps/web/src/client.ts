import type { ApiFailure, Attachment } from "@tsudoi/contracts";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function failure(status: number, data?: Partial<ApiFailure>) {
  return new ApiError(status, data?.error?.message || "Не удалось выполнить запрос. Попробуйте ещё раз.");
}

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch("/api" + path, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw failure(response.status, data);
  return data;
}

export function uploadFile(chatId: string, file: File, onProgress: (percent: number) => void, signal: AbortSignal) {
  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.open("POST", "/api/chats/" + encodeURIComponent(chatId) + "/uploads");
    xhr.responseType = "json";
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
    xhr.onerror = () => reject(new Error("Связь прервалась"));
    xhr.onabort = () => reject(new DOMException("Загрузка отменена", "AbortError"));
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response as Attachment) : reject(failure(xhr.status, xhr.response));
    const body = new FormData();
    body.append("file", file);
    xhr.send(body);
  });
}

export function errorText(error: unknown) {
  return error instanceof ApiError ? error.message : "Не удалось связаться с сервером. Проверьте соединение и попробуйте ещё раз.";
}

export function dateTime(iso: string) {
  return new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function fileSize(size: number) {
  if (size < 1024) return size + " Б";
  return size < 1024 * 1024 ? Math.ceil(size / 1024) + " КБ" : (size / (1024 * 1024)).toLocaleString("ru", { maximumFractionDigits: 1 }) + " МБ";
}

export function createClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState({}, "", path);
  else history.pushState({ previousPath: location.pathname }, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function backToList() {
  if (history.state?.previousPath === "/") history.back();
  else navigate("/", true);
}

export const chatPath = (id: string) => "/chat/" + encodeURIComponent(id);
export const chatApi = (id: string) => "/chats/" + encodeURIComponent(id);
