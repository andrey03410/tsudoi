import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Actor, Attachment, ChatDetail, Message, MessagePage } from "@tsudoi/contracts";
import { ArrowDown, ArrowLeft, Download, File, LoaderCircle, MessageCircle, Pause, Play, SmilePlus, UserRound, UsersRound } from "lucide-react";
import { api, ApiError, backToList, chatApi, dateTime, errorText, fileSize } from "./client";
import { Composer, stickers } from "./Composer";
import { mergeMessages, prependMessages, rememberPageChanges } from "./history";
import type { PageChanges } from "./history";
import { Members } from "./Management";
import { Avatar, ErrorNote, IconButton } from "./ui";

const emojis = ["👍", "❤️", "😂", "🔥", "😮", "😢"];
const time = (iso: string) => new Date(iso).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
function day(iso: string) {
  const date = new Date(iso);
  if (date.toDateString() === new Date().toDateString()) return "Сегодня";
  return date.toLocaleDateString("ru", { day: "numeric", month: "long", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function Media({ file }: { file: Attachment }) {
  const [playing, setPlaying] = useState(false);
  const url = "/api/files/" + encodeURIComponent(file.id);
  if (file.mime === "image/gif") return <div className="gif-attachment"><button className="gif-preview" aria-label={(playing ? "Остановить GIF " : "Воспроизвести GIF ") + file.name} onClick={() => setPlaying(!playing)}>
    {playing && <img alt={file.name} src={url}/>}<span>{playing ? <Pause size={18}/> : <Play size={18}/>} GIF</span></button><a href={url + "?download=1"} download>{file.name}<Download size={14}/></a></div>;
  if (/^image\/(jpeg|png|webp|avif)$/.test(file.mime)) return <a className="image-file" aria-label={"Скачать " + file.name} href={url + "?download=1"} download><img alt={file.name} src={url} loading="lazy"/></a>;
  return <a className="file-link" href={url + "?download=1"} download><File size={24}/><span><strong>{file.name}</strong><small>{fileSize(file.size)}</small></span><Download size={17}/></a>;
}

function Bubble({ msg, own, group, react }: { msg: Message; own: boolean; group: boolean; react: (id: number, emoji: string, active: boolean) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !trigger.current?.contains(e.target)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  async function toggle(emoji: string) {
    setOpen(false); setBusy(true);
    try { await react(msg.id, emoji, !msg.reactions.some(r => r.emoji === emoji && r.mine)); } finally { setBusy(false); }
  }
  return <article className={"message " + (own ? "own" : "other")} data-message-id={msg.id} aria-label={msg.author.displayName + ", " + time(msg.createdAt)}>
    {!own && group && <Avatar small name={msg.author.displayName}/>}
    <div className="message-body">
      <div className={"bubble" + (msg.stickerId ? " is-sticker" : "")}>
        {group && <div className="author">{msg.author.displayName}{msg.author.role === "guest" && <small>Гость</small>}</div>}
        {msg.stickerId && <img className="sticker-image" alt={"Стикер «" + (stickers[msg.stickerId] || "Tsudoi") + "»"} src={"/stickers/" + encodeURIComponent(msg.stickerId) + ".png"}/>}
        {msg.attachments.map(file => <Media key={file.id} file={file}/>)}
        {msg.text && <p>{msg.text}</p>}
        <time dateTime={msg.createdAt}>{time(msg.createdAt)}</time>
      </div>
      <div className="reactions">{msg.reactions.map(r => {
        const guestCount = r.guestCount;
        const description = guestCount ? "Реакций от гостей: " + guestCount : undefined;
        return <button key={r.emoji} className="reaction" disabled={busy} aria-pressed={r.mine} title={description} aria-description={description} onClick={() => void toggle(r.emoji)}>{r.emoji} {r.count}{guestCount > 0 && <span className="guest-reaction" aria-hidden="true"><UserRound size={11}/>{guestCount}</span>}</button>;
      })}
        <div className="reaction-menu" ref={trigger}><IconButton label="Добавить реакцию" disabled={busy} aria-expanded={open} onClick={() => setOpen(!open)}><SmilePlus size={15}/></IconButton>
          {open && <div className="emoji-panel">{emojis.map(emoji => <button key={emoji} aria-label={emoji} aria-pressed={msg.reactions.some(r => r.emoji === emoji && r.mine)} onClick={() => void toggle(emoji)}>{emoji}</button>)}</div>}
        </div>
      </div>
    </div>
  </article>;
}

interface ConversationProps {
  id: string; actor: Actor; signal: number; online: boolean; listChanged: () => void; denied: () => void;
}

export function Conversation({ id, actor, signal, online, listChanged, denied }: ConversationProps) {
  const path = chatApi(id);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [older, setOlder] = useState(false);
  const [paging, setPaging] = useState(false);
  const [members, setMembers] = useState(false);
  const [jump, setJump] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const history = useRef<HTMLDivElement>(null);
  const olderRequest = useRef<{ before: number; changes: PageChanges } | null>(null);
  const cursor = useRef<number | null>(null);
  const sync = useRef<() => void>(() => {});
  const follow = useRef(true);
  const anchor = useRef<{ id: number; top: number } | null>(null);
  const readThrough = useRef(0);
  const readBusy = useRef(false);
  const readFrame = useRef(0);
  const live = useRef(true);
  const refreshDetail = useCallback(async () => {
    const result = await api<ChatDetail>(path);
    if (live.current) setDetail(result);
  }, [path]);
  const failed = useCallback((err: unknown) => {
    if (!live.current) return;
    if (err instanceof ApiError && [401, 403, 404].includes(err.status)) { denied(); return; }
    setError(errorText(err));
  }, [denied]);
  useEffect(() => {
    live.current = true;
    let running = false, again = false, cancelled = false;
    async function pull() {
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          const info = await api<ChatDetail>(path);
          if (cancelled) return;
          setDetail(info);
          if (cursor.current === null) {
            const page: MessagePage = await api<MessagePage>(path + "/messages");
            if (cancelled) return;
            cursor.current = page.cursor; setMessages(page.messages); setOlder(page.hasMore); setLoaded(true);
          } else {
            let more = false;
            do {
              const page: MessagePage = await api<MessagePage>(path + "/changes?after=" + cursor.current);
              if (cancelled) return;
              cursor.current = page.cursor; more = page.hasMore;
              const pending = olderRequest.current;
              if (pending) rememberPageChanges(pending.changes, page.messages, pending.before, page.cursor);
              if (page.messages.length) setMessages(current => mergeMessages(current, page.messages.filter(m => !current.length || m.id >= current[0].id)));
            } while (more);
          }
          setError("");
        } while (again);
      } catch (err) { if (!cancelled) failed(err); }
      finally { running = false; }
    }
    sync.current = () => void pull();
    sync.current();
    return () => { live.current = false; cancelled = true; cancelAnimationFrame(readFrame.current); };
  }, [path, failed]);
  useEffect(() => { sync.current(); }, [signal, retry]);
  const mark = useCallback(() => {
    cancelAnimationFrame(readFrame.current);
    readFrame.current = requestAnimationFrame(async () => {
      const el = history.current;
      if (!el || !live.current || document.hidden || !document.hasFocus() || readBusy.current) return;
      const rect = el.getBoundingClientRect();
      const visible = [...el.querySelectorAll<HTMLElement>("[data-message-id]")].filter(row => {
        const box = row.getBoundingClientRect();
        return box.top < rect.bottom - 2 && box.bottom > rect.top + 2;
      });
      const id = Number(visible.at(-1)?.dataset.messageId);
      if (!id || id <= readThrough.current) return;
      readBusy.current = true;
      try {
        await api(path + "/read", "POST", { messageId: id });
        if (live.current) { readThrough.current = id; listChanged(); mark(); }
      } catch (err) { failed(err); }
      finally { readBusy.current = false; }
    });
  }, [path, failed, listChanged]);
  function scrollState() {
    const el = history.current;
    if (!el) return;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setJump(!follow.current); mark();
  }
  useLayoutEffect(() => {
    const el = history.current;
    if (!el) return;
    if (anchor.current) {
      const previous = el.querySelector<HTMLElement>('[data-message-id="' + anchor.current.id + '"]');
      if (previous) el.scrollTop += previous.getBoundingClientRect().top - anchor.current.top;
      anchor.current = null;
    } else if (follow.current) el.scrollTop = el.scrollHeight;
    mark();
  }, [messages, loaded, mark]);
  useEffect(() => {
    window.addEventListener("focus", mark); document.addEventListener("visibilitychange", mark);
    return () => { window.removeEventListener("focus", mark); document.removeEventListener("visibilitychange", mark); };
  }, [mark]);
  async function earlier() {
    if (olderRequest.current || !messages.length) return;
    const request = { before: messages[0].id, changes: new Map() as PageChanges };
    olderRequest.current = request;
    setPaging(true);
    try {
      const page: MessagePage = await api<MessagePage>(path + "/messages?before=" + request.before);
      if (!live.current) return;
      const row = history.current?.querySelector<HTMLElement>("[data-message-id]");
      if (row) anchor.current = { id: Number(row.dataset.messageId), top: row.getBoundingClientRect().top };
      follow.current = false; setMessages(current => prependMessages(current, page.messages, request.changes, page.cursor)); setOlder(page.hasMore);
    } catch (err) { failed(err); } finally { olderRequest.current = null; if (live.current) setPaging(false); }
  }
  async function react(messageId: number, emoji: string, active: boolean) {
    try { await api(path + "/messages/" + messageId + "/reactions", "PUT", { emoji, active }); sync.current(); }
    catch (err) { failed(err); }
  }
  function bottom() { follow.current = true; if (history.current) history.current.scrollTop = history.current.scrollHeight; setJump(false); mark(); }
  const group = detail?.kind === "group";
  return <main className="conversation">
    <header className="chat-header">
      <IconButton className="mobile-back" label="К списку чатов" onClick={backToList}><ArrowLeft/></IconButton>
      <Avatar name={detail?.title || "…"} group={group}/><div className="chat-heading"><h1>{detail?.title || "Загрузка…"}</h1><small>{actor.role === "guest" && actor.expiresAt ? "Гостевой доступ до " + dateTime(actor.expiresAt) : group ? "Участников: " + detail?.members.length : "Личный диалог"}</small></div>
      {group && <IconButton className="member-toggle" label="Участники группы" onClick={() => setMembers(true)}><UsersRound/></IconButton>}
    </header>
    {!online && <p role="status" className="connection">Восстанавливаем соединение…</p>}
    {error && <div className="chat-error"><ErrorNote message={error}/><button className="text-button" onClick={() => setRetry(n => n + 1)}>Повторить</button></div>}
    <div className="history-wrap"><div className="history" ref={history} onScroll={scrollState} onLoadCapture={() => { if (follow.current && history.current) history.current.scrollTop = history.current.scrollHeight; mark(); }}>
      <div className="message-list">
        {older && <button className="load-older" onClick={() => void earlier()} disabled={paging}>{paging ? "Загружаем…" : "Загрузить предыдущие сообщения"}</button>}
        {!loaded && !error && <p className="history-status" role="status"><LoaderCircle className="spin"/>Загружаем сообщения…</p>}
        {loaded && messages.length === 0 && <div className="empty-chat"><span className="empty-icon"><MessageCircle/></span><h2>Пока нет сообщений</h2><p>Напишите первое сообщение.</p></div>}
        {messages.map((msg, index) => <div key={msg.id} className="message-row">{(index === 0 || day(messages[index - 1].createdAt) !== day(msg.createdAt)) && <div className="day-divider"><span>{day(msg.createdAt)}</span></div>}<Bubble msg={msg} own={msg.author.id === actor.id} group={Boolean(group)} react={react}/></div>)}
      </div>
    </div>{jump && <button className="jump" onClick={bottom}><ArrowDown size={16}/>К последним</button>}</div>
    {detail && <Composer chatId={id} sent={() => { bottom(); sync.current(); listChanged(); }}/>}
    {members && detail && <Members detail={detail} actor={actor} refresh={refreshDetail} close={() => setMembers(false)}/>}
  </main>;
}
