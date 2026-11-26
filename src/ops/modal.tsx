import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = "button:not(:disabled), input, select, [tabindex]:not([tabindex='-1'])";

export function Modal({
  title,
  children,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  onCancel?: () => void;
  onConfirm?: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    (box.querySelector<HTMLElement>("[data-autofocus]") ?? box).focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && onConfirm && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      onConfirm();
    } else if (event.key === "Tab") {
      const focusable = Array.from(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (!focusable.length) return;
      const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
      if (document.activeElement === edge) {
        event.preventDefault();
        focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
      }
    }
  }

  return (
    <div className="scrim">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={boxRef} onKeyDown={onKeyDown}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export const Buttons = ({ children }: { children: ReactNode }) => <div className="modal-actions">{children}</div>;
