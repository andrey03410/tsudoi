import { useKaname } from "./Kaname";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Actor, InviteAccepted, InviteKind, InvitePreview } from "@tsudoi/contracts";
import { ArrowRight, Eye, EyeOff, KeyRound, LoaderCircle } from "lucide-react";
import { api, ApiError, chatApi, chatPath, dateTime, errorText, navigate } from "./client";
import { Brand, ErrorNote, IconButton } from "./ui";

interface AuthProps { actor: Actor | null; kind?: InviteKind; token: string; onSession: (actor: Actor) => void; notice: string }

export function Auth({ actor, kind, token, onSession, notice }: AuthProps) {
  const kaname = useKaname();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => {
    if (!kind) return;
    let live = true;
    async function load() {
      try {
        const data = await api<InvitePreview>("/invites/preview", "POST", { kind, token });
        if (data.chatId && actor) {
          const member = await api(chatApi(data.chatId)).then(() => true, () => false);
          if (live && member) { navigate(chatPath(data.chatId), true); return; }
        }
        if (live) setPreview(data);
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) setInvalid(true);
        else setError(errorText(err));
      }
    }
    void load();
    return () => { live = false; };
  }, [actor, kind, token, loadAttempt]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const result = kind ? await api<InviteAccepted>("/invites/accept", "POST", { kind, token, ...values }) : await api<InviteAccepted>("/login", "POST", values);
      onSession(result.actor);
      navigate(result.chatId ? chatPath(result.chatId) : !kind && location.pathname.startsWith("/chat/") ? location.pathname : "/", true);
    } catch (err) {
      if (kind && err instanceof ApiError && err.status === 404) setInvalid(true);
      else setError(errorText(err));
    } finally { setBusy(false); }
  }
  const title = invalid ? "Приглашение недоступно" : kind === "guest" ? preview?.title || "Приглашение в группу" : kind === "account" ? "Создать аккаунт" : "С возвращением";
  const back = () => navigate("/", true);
  return <main className="auth-screen">
    <div className="auth-container">
      <section className="auth-art" aria-label="Tsudoi"><Brand/><div aria-hidden="true" className="art-seal" lang="ja">集い</div></section>
      <section className="auth-panel"><div className="auth-form">
        <div className="mobile-brand"><Brand/></div>
        <h1>{title}</h1>
        {kaname?.enabled && !kind ? <a className="primary auth-submit" href={"/api/auth/kaname/login?next=" + encodeURIComponent(location.pathname)}>Войти через Kaname</a> : invalid ? <><p>Ссылка уже использована, отозвана или истекла. Попросите у пригласившего новую ссылку.</p><button className="primary" onClick={back}>Вернуться в Tsudoi</button></> :
          kind && !preview ? error ? <><ErrorNote message={error}/><button className="secondary" onClick={() => { setError(""); setLoadAttempt(n => n + 1); }}>Повторить</button></> : <p role="status">Проверяем приглашение…</p> :
          kind && actor ? <><p>Вы вошли как {actor.displayName}. Откройте приглашение в приватном окне или другом профиле браузера.</p><button className="primary" onClick={back}>К моим чатам</button></> :
          <><p className="auth-description">{kind === "guest" ? "Введите имя, которое увидят участники. Гостевой доступ действует 7 суток." : kind === "account" ? "По этому приглашению вы получите постоянный доступ к Tsudoi." : "Войдите в свой аккаунт Tsudoi."}</p>
            <form onSubmit={submit} className="fields">
              {kind && <label>Имя<input name="displayName" autoComplete="nickname" placeholder="Как вас называть?" required maxLength={80}/></label>}
              {kind !== "guest" && <><label>Логин<input name="login" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="Ваш логин" required/></label>
                <label>Пароль<span className="password-field"><input name="password" type={showPassword ? "text" : "password"} autoComplete={kind ? "new-password" : "current-password"} minLength={kind ? 8 : undefined} maxLength={256} placeholder={kind ? "Придумайте пароль" : "Введите пароль"} required/><IconButton label={showPassword ? "Скрыть пароль" : "Показать пароль"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff/> : <Eye/>}</IconButton></span></label></>}
              <ErrorNote message={error || notice}/>
              <button type="submit" className="primary auth-submit" disabled={busy}>{kind === "guest" ? "Войти в группу" : kind === "account" ? "Создать аккаунт" : "Войти"}{busy ? <LoaderCircle className="spin"/> : <ArrowRight size={18}/>}</button>
            </form>
            {import.meta.env.VITE_PROVISIONED_ACCOUNTS_ONLY !== "1" && <div className="auth-foot"><KeyRound size={16}/><span>{kind && preview ? "Приглашение действует до " + dateTime(preview.expiresAt) : "Регистрация по приглашению"}</span></div>}
          </>}
      </div></section>
    </div>
  </main>;
}
