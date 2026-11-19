import { useEffect, useId, useRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { X, UsersRound } from "lucide-react";

export function Brand() {
  return <div className="brand" aria-label="Tsudoi"><span className="brand-mark" aria-hidden="true">集</span><span>Tsudoi</span></div>;
}

export function Avatar({ name, group = false, small = false }: { name: string; group?: boolean; small?: boolean }) {
  const color = [...name].reduce((sum, c) => sum + (c.codePointAt(0) || 0), 0) % 5;
  const initials = name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join("").toLocaleUpperCase();
  return <span aria-hidden="true" className={'avatar tone-' + color + (small ? " small" : "") + (group ? " group" : "")}>{group ? <UsersRound size={small ? 16 : 22}/> : initials}</span>;
}

export function IconButton({ label, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} className={"icon-button " + className} {...props}>{children}</button>;
}

export function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby={id} onCancel={e => { e.preventDefault(); close(); }} onClick={e => {
    if (e.target === ref.current) {
      const box = ref.current.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) close();
    }
  }}>
    <header className="modal-header"><h2 id={id}>{title}</h2><IconButton label="Закрыть" onClick={close}><X/></IconButton></header>
    <div className="modal-body">{children}</div>
  </dialog>;
}

export function ErrorNote({ message }: { message: string }) {
  return message ? <p role="alert" className="error-note">{message}</p> : null;
}
