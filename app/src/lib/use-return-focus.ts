import { useRef } from "react";

let opener: HTMLElement | null = null;

export function rememberOpener(element: HTMLElement): void {
  opener = element;
}

function focusedOrigin(): HTMLElement | null {
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    !active.closest('[role="menu"]')
  ) {
    return active;
  }
  return opener;
}

export function useReturnFocus(
  onOpen?: (event: Event) => void,
  onClose?: (event: Event) => void,
) {
  const returnTo = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (event: Event) => {
      returnTo.current = focusedOrigin();
      onOpen?.(event);
    },
    onCloseAutoFocus: (event: Event) => {
      onClose?.(event);
      const target = returnTo.current;
      if (event.defaultPrevented || !target?.isConnected) return;
      event.preventDefault();
      target.focus({ preventScroll: true });
    },
  };
}
