import { useEffect, useRef, useState } from "react";
import type { Actor, ChatDetail, Invite, IssuedInvite } from "@tsudoi/contracts";
import { Check, Copy, Link2, MessageCircle, Plus, UserMinus, UsersRound } from "lucide-react";
import { api, chatApi, chatPath, dateTime, errorText, navigate } from "./client";
import { Avatar, ErrorNote, IconButton, Modal } from "./ui";

export function NewChat({ actor, close }: { actor: Actor; close: () => void }) {
  const [group, setGroup] = useState(false);
  const [users, setUsers] = useState<Actor[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<Actor[]>("/users").then(list => setUsers(list.filter(user => user.id !== actor.id))).catch(err => setError(errorText(err))); }, [actor.id]);
  async function create(userId?: string) {
    if (busy) return;
    setError(""); setBusy(true);
    try {
      const chat = await api<{ id: string }>(group ? "/chats/group" : "/chats/direct", "POST", group ? { title: title.trim(), memberIds: selected } : { userId });
      close(); navigate(chatPath(chat.id));
    } catch (err) { setError(errorText(err)); setBusy(false); }
  }
  return <Modal title="Новый чат" close={close}>
    <div className="segments"><button aria-pressed={!group} onClick={() => setGroup(false)}><MessageCircle/>Личный диалог</button><button aria-pressed={group} onClick={() => setGroup(true)}><UsersRound/>Группа</button></div>
    <form className="fields" onSubmit={e => { e.preventDefault(); if (group) void create(); }}>
      {group && <label>Название группы<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={160} placeholder="Название"/></label>}
      <h3>{group ? "Участники" : "Собеседники"}</h3>
      <div className="people-list">
        {users?.map(person => group ? <label className="person-row" key={person.id}><Avatar name={person.displayName} small/><span>{person.displayName}</span><input type="checkbox" checked={selected.includes(person.id)} onChange={e => setSelected(e.target.checked ? [...selected, person.id] : selected.filter(id => id !== person.id))}/></label> :
          <button type="button" key={person.id} disabled={busy} className="person-row" onClick={() => void create(person.id)}><Avatar small name={person.displayName}/><span>{person.displayName}</span></button>)}
        {users?.length === 0 && <p className="muted">{group ? "Можно создать группу и пригласить участников позже." : "Пока нет других участников."}</p>}
        {!users && !error && <p role="status">Загружаем участников…</p>}
      </div>
      <ErrorNote message={error}/>
      {group && <button className="primary" disabled={busy || !title.trim()}>Создать группу</button>}
    </form>
  </Modal>;
}

const statuses = { active: "Действует", used: "Использовано", expired: "Истекло", revoked: "Отозвано" };

export function Invitations({ groupId }: { groupId?: string }) {
  const path = groupId ? chatApi(groupId) + "/invites" : "/invites/account";
  const [invites, setInvites] = useState<Invite[]>([]);
  const [issued, setIssued] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const readVersion = useRef(0);
  useEffect(() => {
    async function refresh() {
      const version = ++readVersion.current;
      try {
        const current = await api<Invite[]>(path);
        if (version !== readVersion.current) return;
        setInvites(current);
        setIssued(visible => visible && current.some(item => item.id === visible.id && item.status === "active") ? visible : null);
      } catch (err) {
        if (version === readVersion.current) setError(errorText(err));
      }
    }
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { readVersion.current++; window.removeEventListener("focus", refresh); };
  }, [path]);
  async function issue() {
    if (busy) return;
    setBusy(true); setError(""); setCopied(false);
    try {
      const data = await api<IssuedInvite>(path, "POST");
      readVersion.current++;
      setIssued({ id: data.invite.id, url: location.origin + "/invite/" + data.invite.kind + "#" + data.token });
      setInvites(current => [data.invite, ...current.filter(item => item.id !== data.invite.id)]);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const current = await api<Invite>(path + "/" + id, "DELETE");
      readVersion.current++;
      setInvites(list => list.map(item => item.id === id ? current : item));
      setIssued(visible => visible?.id === id && current.status !== "active" ? null : visible);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return <section className="invite-list">
    <p className="muted">{groupId ? "Одноразовая ссылка действует 24 часа. Гость получит доступ к группе на 7 суток." : "Одноразовая ссылка для регистрации действует 7 суток."}</p>
    <button className="secondary" disabled={busy} onClick={() => void issue()}><Plus/>Создать приглашение</button>
    {issued && <div className="issued"><label>Ссылка приглашения<input ref={field} readOnly value={issued.url} onFocus={e => e.currentTarget.select()}/></label>
      <button className="text-button" onClick={async () => {
        try { await navigator.clipboard.writeText(issued.url); setCopied(true); } catch { field.current?.focus(); field.current?.select(); setError("Скопируйте выделенную ссылку."); }
      }}>{copied ? <Check/> : <Copy/>}{copied ? "Скопировано" : "Скопировать ссылку"}</button></div>}
    <ErrorNote message={error}/>
    {invites.map(item => {
      const status = item.status === "active" && new Date(item.expiresAt).getTime() <= Date.now() ? "expired" : item.status;
      return <div className="invite-row" key={item.id}><Link2 size={18}/><div><strong>{statuses[status]}</strong><small>До {dateTime(item.expiresAt)}</small></div>{status === "active" && <button className="text-button danger" disabled={busy} onClick={() => void revoke(item.id)}>Отозвать</button>}</div>;
    })}
  </section>;
}

export function Members({ detail, actor, refresh, close }: { detail: ChatDetail; actor: Actor; refresh: () => Promise<void>; close: () => void }) {
  const [users, setUsers] = useState<Actor[]>([]);
  const [added, setAdded] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState("");
  useEffect(() => { if (detail.isOwner) void api<Actor[]>("/users").then(setUsers).catch(err => setError(errorText(err))); }, [detail.isOwner]);
  async function change(id: string, remove: boolean) {
    setBusy(true); setError("");
    try {
      const path = chatApi(detail.id) + "/members";
      if (remove) await api(path + "/" + id, "DELETE");
      else await api(path, "POST", { actorId: id });
      setAdded(""); setConfirm(""); await refresh();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  const candidates = users.filter(person => !detail.members.some(member => member.id === person.id));
  return <Modal title="Участники группы" close={close}>
    <div className="people-list">{detail.members.map(person => <div key={person.id} className="person-row"><Avatar small name={person.displayName}/><div><strong>{person.displayName}</strong>{person.role === "guest" && <small>Гость</small>}</div>
      {detail.isOwner && person.id !== actor.id && (confirm === person.id ? <div className="row-confirm"><button className="text-button danger" disabled={busy} onClick={() => void change(person.id, true)}>Удалить</button><button className="text-button" onClick={() => setConfirm("")}>Отмена</button></div> : <IconButton label={"Удалить " + person.displayName} onClick={() => setConfirm(person.id)}><UserMinus/></IconButton>)}</div>)}</div>
    {detail.isOwner && <>{candidates.length > 0 && <form className="fields subsection" onSubmit={e => { e.preventDefault(); if (added) void change(added, false); }}><label>Добавить участника<select value={added} onChange={e => setAdded(e.target.value)}><option value="">Выберите участника</option>{candidates.map(person => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label><button className="secondary" disabled={busy || !added}><Plus/>Добавить</button></form>}
      {import.meta.env.VITE_PROVISIONED_ACCOUNTS_ONLY !== "1" && <div className="subsection"><h3>Гостевые приглашения</h3><Invitations groupId={detail.id}/></div>}</>}
    <ErrorNote message={error}/>
  </Modal>;
}
