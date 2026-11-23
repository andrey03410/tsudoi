import { KanameAccount, useKaname } from "./Kaname";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Actor, ChatSummary, InviteKind, LiveEvent } from "@tsudoi/contracts";
import { KeyRound, LogOut, MessageCircle, MessagesSquare, Plus, SquarePen, UserRound } from "lucide-react";
import { Auth } from "./Auth";
import { api, ApiError, chatPath, errorText, navigate } from "./client";
import { Conversation } from "./Conversation";
import { Invitations, NewChat } from "./Management";
import { Avatar, Brand, ErrorNote, IconButton, Modal } from "./ui";
import "./style.css";

function useLocation() {
  const get = () => window.location.pathname + window.location.hash;
  const [url, setUrl] = useState(get);
  useEffect(() => {
    const change = () => setUrl(get());
    window.addEventListener("popstate", change); window.addEventListener("hashchange", change);
    return () => { window.removeEventListener("popstate", change); window.removeEventListener("hashchange", change); };
  }, []);
  return url;
}

function rowTime(iso: string) {
  const date = new Date(iso);
  return date.toLocaleString("ru", date.toDateString() === new Date().toDateString() ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" });
}

function Workspace({ actor, id, checkSession, logout }: { actor: Actor; id?: string; checkSession: () => Promise<void>; logout: () => Promise<void> }) {
  const kaname = useKaname();
  const [list, setList] = useState<ChatSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [modal, setModal] = useState<"new" | "invites" | "profile" | null>(null);
  const [signal, setSignal] = useState(0);
  const [online, setOnline] = useState(true);
  const [error, setError] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const screen = window.visualViewport;
    if (!screen) return;
    const resize = () => { if (screen.scale === 1) viewport.current?.style.setProperty("--viewport-height", screen.height + "px"); };
    resize();
    screen.addEventListener("resize", resize);
    return () => screen.removeEventListener("resize", resize);
  }, []);
  const selection = useRef(id);
  selection.current = id;
  const listVersion = useRef(0);
  const refresh = useCallback(() => {
    const version = ++listVersion.current;
    void api<ChatSummary[]>("/chats").then(chats => {
      if (version !== listVersion.current) return;
      setList(chats); setLoaded(true);
    }).catch(err => {
      if (version !== listVersion.current) return;
      if (err instanceof ApiError && err.status === 401) void checkSession();
      else setError(errorText(err));
    });
  }, [checkSession]);
  const denied = useCallback(() => {
    setError("Доступ к этому чату завершён.");
    navigate("/", true); refresh(); void checkSession();
  }, [refresh, checkSession]);
  useEffect(() => {
    refresh(); setModal(null);
  }, [id, refresh]);
  useEffect(() => {
    let closed = false, timer = 0;
    let socket: WebSocket | undefined;
    function update() { refresh(); setSignal(n => n + 1); }
    function focus() { if (!document.hidden) { void checkSession(); update(); } }
    function connect() {
      if (closed) return;
      socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
      socket.onopen = () => { if (!closed) { setOnline(true); update(); } };
      socket.onmessage = event => {
        if (closed) return;
        let data: LiveEvent;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === "changed") {
          refresh();
          if (!data.chatId || data.chatId === selection.current) setSignal(n => n + 1);
        }
      };
      socket.onclose = () => {
        if (closed) return;
        setOnline(false);
        void checkSession();
        timer = window.setTimeout(connect, 1600);
      };
    }
    connect();
    window.addEventListener("focus", focus); window.addEventListener("online", focus); document.addEventListener("visibilitychange", focus);
    return () => {
      closed = true; listVersion.current++; clearTimeout(timer); socket?.close();
      window.removeEventListener("focus", focus); window.removeEventListener("online", focus); document.removeEventListener("visibilitychange", focus);
    };
  }, [checkSession, refresh]);
  useEffect(() => {
    const selected = list.find(row => row.id === id);
    document.title = selected ? selected.title + " · Tsudoi" : "Чаты · Tsudoi";
  }, [id, list]);
  return <div ref={viewport} className={"workspace " + (id ? "show-chat" : "show-list")}>
    <aside className="sidebar" aria-label="Список чатов">
      <div className="brand-bar"><Brand/>{actor.role === "admin" && !kaname?.enabled && import.meta.env.VITE_PROVISIONED_ACCOUNTS_ONLY !== "1" && <IconButton label="Приглашения" onClick={() => setModal("invites")}><KeyRound/></IconButton>}</div>
      <header className="sidebar-heading"><h1>Чаты</h1>{actor.role !== "guest" && <IconButton label="Новый чат" className="new-chat-button" onClick={() => setModal("new")}><SquarePen size={18}/></IconButton>}</header>
      <nav className="chat-list" aria-label="Чаты">{list.map(chat => <a key={chat.id} href={chatPath(chat.id)} onClick={e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); setError(""); navigate(chatPath(chat.id));
      }} className={"chat-row " + (chat.id === id ? "selected" : "")} aria-current={chat.id === id ? "page" : undefined}>
        <Avatar name={chat.title} group={chat.kind === "group"}/>
        <div className="row-text"><div className="row-title"><strong>{chat.title}</strong>{chat.lastMessageAt && <time>{rowTime(chat.lastMessageAt)}</time>}</div><div className="row-preview"><span>{chat.preview || "Пока нет сообщений"}</span>{chat.unreadCount > 0 && <b aria-label={"Непрочитанных: " + chat.unreadCount}>{chat.unreadCount}</b>}</div></div>
      </a>)}
        {loaded && list.length === 0 && <div className="empty-list"><MessagesSquare size={25}/><strong>Пока нет чатов</strong>{actor.role !== "guest" && <button className="text-button" onClick={() => setModal("new")}><Plus size={15}/>Новый чат</button>}</div>}
        {!loaded && !error && <p className="muted">Загружаем чаты…</p>}
      </nav>
      {error && <div className="side-error"><ErrorNote message={error}/><button className="text-button" onClick={() => { setError(""); refresh(); }}>Обновить</button></div>}
      <button className="profile-row" onClick={() => setModal("profile")}><Avatar name={actor.displayName} small/><span><strong>{actor.displayName}</strong><small>{actor.role === "admin" ? "Администратор" : actor.role === "guest" ? "Гость" : "Участник"}</small></span><UserRound size={17}/></button>
    </aside>
    {id ? <Conversation key={id} id={id} actor={actor} signal={signal} online={online} listChanged={refresh} denied={denied}/> : <main className="no-conversation">
      <div className="empty-art" aria-hidden="true"><span lang="ja">集い</span></div><div className="no-chat-copy"><div className="empty-icon"><MessageCircle/></div><h2>{list.length ? "Выберите чат" : "Начните разговор"}</h2>
      <p>{list.length ? "Откройте диалог или группу в списке чатов." : "Создайте личный диалог или соберите группу."}</p>
      {actor.role !== "guest" && <button className="primary" onClick={() => setModal("new")}><Plus size={18}/>Новый чат</button>}</div>
    </main>}
    {modal === "new" && <NewChat actor={actor} close={() => setModal(null)}/>}
    {modal === "invites" && <Modal title="Приглашения на регистрацию" close={() => setModal(null)}><Invitations/></Modal>}
    {modal === "profile" && <Modal title="Профиль" close={() => setModal(null)}><div className="profile-detail"><Avatar name={actor.displayName}/><strong>{actor.displayName}</strong></div><KanameAccount admin={actor.role === "admin"}/>
      {actor.role === "admin" && !kaname?.enabled && import.meta.env.VITE_PROVISIONED_ACCOUNTS_ONLY !== "1" && <button className="secondary" onClick={() => setModal("invites")}><KeyRound/>Приглашения</button>}
      <button className="text-button danger" onClick={() => void logout().catch(err => setError(errorText(err)))}><LogOut/>Выйти</button></Modal>}
  </div>;
}

function App() {
  const url = useLocation();
  const [actor, setActor] = useState<Actor | null | undefined>(undefined);
  const [notice, setNotice] = useState("");
  const current = useRef<Actor | null | undefined>(undefined);
  const version = useRef(0);
  const session = useCallback((value: Actor | null) => {
    version.current++;
    if (!value && current.current?.role === "guest") setNotice("Гостевой доступ завершён. Попросите владельца группы прислать новое приглашение.");
    if (value) setNotice("");
    current.current = value; setActor(value);
  }, []);
  useEffect(() => {
    if (!actor?.expiresAt) return;
    const deadline = Date.parse(actor.expiresAt);
    const expire = () => { if (Date.now() >= deadline && current.current?.id === actor.id) session(null); };
    const timer = window.setTimeout(expire, Math.max(0, deadline - Date.now()));
    window.addEventListener("focus", expire);
    document.addEventListener("visibilitychange", expire);
    return () => {
      clearTimeout(timer); window.removeEventListener("focus", expire); document.removeEventListener("visibilitychange", expire);
    };
  }, [actor, session]);
  const check = useCallback(async () => {
    const initial = version.current;
    try {
      const data = await api<{ actor: Actor | null }>("/me");
      if (initial === version.current) session(data.actor);
    } catch (err) {
      if (initial !== version.current) return;
      if (current.current?.expiresAt && Date.parse(current.current.expiresAt) <= Date.now()) { session(null); return; }
      if (err instanceof ApiError && err.status === 401) session(null);
      else if (!current.current) setNotice(errorText(err));
    }
  }, [session]);
  useEffect(() => { void check(); }, [check]);
  const [path, token = ""] = url.split("#");
  const config = useKaname();
  const invitation = path.match(/^\/invite\/(account|guest)\/?$/)?.[1] as InviteKind | undefined;
  const kind = config?.enabled ? (invitation === "guest" && config.guestsEnabled ? invitation : undefined)
    : import.meta.env.VITE_PROVISIONED_ACCOUNTS_ONLY === "1" ? undefined : invitation;
  const id = path.match(/^\/chat\/([^/]+)\/?$/)?.[1];
  if (actor === undefined || !config) return <main className="loading-screen"><Brand/>{notice ? <><ErrorNote message={notice}/><button className="secondary" onClick={() => void check()}>Повторить</button></> : <p role="status">Загрузка…</p>}</main>;
  if (!actor || kind) return <Auth key={url} kind={kind} token={token} actor={actor} notice={notice} onSession={session}/>;
  return <Workspace key={actor.id} actor={actor} id={id} checkSession={check} logout={async () => { await api("/logout", "POST"); session(null); setNotice(""); navigate("/", true); }}/>;
}

createRoot(document.getElementById("root")!).render(<App/>);
