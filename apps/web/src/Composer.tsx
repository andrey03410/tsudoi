import { useEffect, useRef, useState } from "react";
import type { Attachment, Message } from "@tsudoi/contracts";
import { ArrowUp, Check, File, LoaderCircle, Paperclip, RotateCw, Sticker, X } from "lucide-react";
import { api, ApiError, chatApi, createClientId, errorText, fileSize, uploadFile } from "./client";
import { ErrorNote, IconButton } from "./ui";

export const stickers: Record<string, string> = { wave: "Привет", cheer: "Ура", hearts: "Любовь", tea: "Чай", giggle: "Смех", sleepy: "Сон" };
interface DraftFile {
  key: string; file: globalThis.File; preview?: string; progress: number; controller: AbortController;
  attachment?: Attachment; error?: string;
}
interface Pending { clientId: string; text?: string; stickerId?: string; attachmentIds?: string[] }

export function Composer({ chatId, sent }: { chatId: string; sent: (message: Message) => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<DraftFile[]>([]);
  const entries = useRef<DraftFile[]>([]);
  const [panel, setPanel] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(false);
  const pending = useRef<Pending | null>(null);
  const submitting = useRef(false);
  const alive = useRef(true);
  const chooser = useRef<HTMLInputElement>(null);
  const gif = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stickerButton = useRef<HTMLDivElement>(null);
  function updateFiles(list: DraftFile[]) {
    entries.current = list;
    setFiles(list);
  }
  function updateFile(key: string, patch: Partial<DraftFile>) {
    if (alive.current) updateFiles(entries.current.map(row => row.key === key ? { ...row, ...patch } : row));
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const row of entries.current) {
        row.controller.abort();
        if (row.preview) URL.revokeObjectURL(row.preview);
        if (!pending.current && row.attachment) void api("/uploads/" + row.attachment.id, "DELETE").catch(() => {});
      }
    };
  }, []);
  useEffect(() => {
    if (!panel) return;
    const close = (e: PointerEvent) => { if (e.target instanceof Node && !stickerButton.current?.contains(e.target)) setPanel(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setPanel(false); stickerButton.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [panel]);
  async function upload(row: DraftFile) {
    if (row.file.size > 25 * 1024 * 1024) { updateFile(row.key, { error: "Файл больше 25 МиБ" }); return; }
    try {
      const attachment = await uploadFile(chatId, row.file, progress => updateFile(row.key, { progress }), row.controller.signal);
      if (alive.current && entries.current.some(item => item.key === row.key)) updateFile(row.key, { attachment, progress: 100 });
      else void api("/uploads/" + attachment.id, "DELETE").catch(() => {});
    } catch (err) { if (!row.controller.signal.aborted) updateFile(row.key, { error: errorText(err) }); }
  }
  function pick(list: FileList | null) {
    if (!list?.length) return;
    const slots = 5 - entries.current.length;
    setError(list.length > slots ? "К сообщению можно прикрепить до 5 файлов." : "");
    const chosen = Array.from(list).slice(0, slots).map(file => ({
      key: createClientId(), file, progress: 0, controller: new AbortController(),
      preview: /^image\/(gif|png|jpeg|webp|avif)$/i.test(file.type) ? URL.createObjectURL(file) : undefined,
    }));
    updateFiles([...entries.current, ...chosen]);
    chosen.forEach(row => void upload(row));
  }
  function remove(row: DraftFile) {
    row.controller.abort();
    if (row.preview) URL.revokeObjectURL(row.preview);
    if (row.attachment) void api("/uploads/" + row.attachment.id, "DELETE").catch(() => {});
    updateFiles(entries.current.filter(item => item.key !== row.key));
  }
  const ready = !files.some(row => !row.attachment) && Boolean(text.trim() || files.length);
  async function send(stickerId?: string) {
    if (submitting.current || (!pending.current && !stickerId && !ready)) return;
    const body = pending.current || (stickerId ? { clientId: createClientId(), stickerId } : {
      clientId: createClientId(), text: text.trim() || undefined, attachmentIds: entries.current.map(row => row.attachment!.id),
    });
    pending.current = body; submitting.current = true;
    setPanel(false); setBusy(true); setError("");
    try {
      const result = await api<Message>(chatApi(chatId) + "/messages", "POST", body);
      if (!alive.current) return;
      if (!body.stickerId) {
        entries.current.forEach(row => { if (row.preview) URL.revokeObjectURL(row.preview); });
        updateFiles([]); setText("");
      }
      pending.current = null; setRetry(false); sent(result);
      requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    } catch (err) {
      if (alive.current) {
        setError(errorText(err));
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) { pending.current = null; setRetry(false); }
        else setRetry(true);
      }
    } finally { submitting.current = false; if (alive.current) setBusy(false); }
  }
  const locked = busy || retry;
  return <footer className="composer">
    <div className="compose-inner">
      {!!files.length && <div className="draft-files">{files.map(row => <div className="draft-item" key={row.key}>
        {row.preview ? <img alt="" src={row.preview}/> : <File size={20}/>}
        <div><strong>{row.file.name}</strong><small>{row.error || (row.attachment ? fileSize(row.file.size) : "Загрузка " + row.progress + "%")}</small></div>
        {row.error && row.file.size <= 25 * 1024 * 1024 && <IconButton disabled={locked} label={"Повторить загрузку " + row.file.name} onClick={() => { updateFile(row.key, { error: undefined, progress: 0 }); void upload(row); }}><RotateCw/></IconButton>}
        {row.attachment && <Check size={14}/>}
        <IconButton label={"Убрать " + row.file.name} disabled={locked} onClick={() => remove(row)}><X/></IconButton>
      </div>)}</div>}
      <ErrorNote message={error}/>
      {retry && <div className="retry"><button className="text-button" disabled={busy} onClick={() => void send()}><RotateCw/>Повторить отправку</button></div>}
      <form onSubmit={e => { e.preventDefault(); void send(); }} className="compose-box">
        <textarea ref={input} aria-label="Сообщение" placeholder="Напишите сообщение…" value={text} disabled={locked} rows={1} maxLength={16000} onChange={e => setText(e.target.value)} onKeyDown={e => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && matchMedia("(pointer:fine)").matches) { e.preventDefault(); void send(); }
        }}/>
        <div className="compose-actions">
          <IconButton label="Прикрепить файл" disabled={locked} onClick={() => chooser.current?.click()}><Paperclip/></IconButton>
          <input ref={chooser} type="file" multiple hidden aria-label="Выбрать файлы" onChange={e => { pick(e.target.files); e.target.value = ""; }}/>
          <IconButton label="Прикрепить GIF" disabled={locked} onClick={() => gif.current?.click()}><span className="gif-mark">GIF</span></IconButton>
          <input ref={gif} type="file" accept="image/gif" hidden aria-label="Выбрать GIF" onChange={e => { pick(e.target.files); e.target.value = ""; }}/>
          <div className="sticker-menu" ref={stickerButton}><IconButton label="Стикеры" aria-expanded={panel} disabled={locked} onClick={() => setPanel(!panel)}><Sticker/></IconButton>
            {panel && <div className="sticker-panel"><h3>Стикеры</h3><div>{Object.entries(stickers).map(([id, name]) => <button type="button" key={id} aria-label={name} title={name} onClick={() => void send(id)}><img alt="" src={"/stickers/" + id + ".png"}/></button>)}</div></div>}
          </div>
          <span className="send-status" role="status">{busy && "Отправляем…"}</span>
          <button className="send-button" aria-label="Отправить" title="Отправить" disabled={locked || !ready}>{busy ? <LoaderCircle className="spin"/> : <ArrowUp size={21}/>}</button>
        </div>
      </form>
    </div>
  </footer>;
}
