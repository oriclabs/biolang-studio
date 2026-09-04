import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function DialogShell({ label, close, children }: { label: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    const focusable = () => element ? [...element.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
    (element?.querySelector<HTMLElement>("[autofocus]") ?? focusable()[0] ?? element)?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); element?.focus(); return; }
      const first = items[0]; const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    addEventListener("keydown", keys);
    return () => { removeEventListener("keydown", keys); previous?.focus(); };
  }, []);
  return <div ref={dialog} className="modal-backdrop" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>{children}</div>;
}
