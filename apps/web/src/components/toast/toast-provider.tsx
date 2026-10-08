import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

import { createToastOutlets, type ToastOutlets } from './toast-outlets.js';
import { createToastStore, type ToastInput, type ToastStore } from './toast-store.js';

const ToastContext = createContext<ToastStore | null>(null);
const ToastOutletsContext = createContext<ToastOutlets | null>(null);

export interface ToastProviderProps {
  /** A store created outside React, to show toasts from query-cache callbacks for instance. */
  store?: ToastStore | undefined;
  children: ReactNode;
}

export function ToastProvider({ store, children }: ToastProviderProps) {
  const [ownStore] = useState(createToastStore);
  const [outlets] = useState(createToastOutlets);
  return (
    <ToastContext value={store ?? ownStore}>
      <ToastOutletsContext value={outlets}>{children}</ToastOutletsContext>
    </ToastContext>
  );
}

export function useToastStore(): ToastStore {
  const store = useContext(ToastContext);
  if (store === null) throw new Error('Toasts need a <ToastProvider> above them');
  return store;
}

export function useToastOutlets(): ToastOutlets {
  const outlets = useContext(ToastOutletsContext);
  if (outlets === null) throw new Error('Toasts need a <ToastProvider> above them');
  return outlets;
}

/**
 * Lets the element in `ref` host the toast region while the calling component is mounted. A modal
 * does this, because the rest of the page is inert while it is open. Without a `<ToastProvider>`
 * it does nothing. A toast control that has the focus when the component mounts passes it on to
 * the same control in the new outlet.
 */
export function useRegisterToastOutlet(ref: RefObject<HTMLElement | null>): void {
  const outlets = useContext(ToastOutletsContext);
  // Before the modal takes the focus into itself, which the effect below comes too late for.
  useLayoutEffect(() => {
    outlets?.holdFocus();
  }, [outlets]);
  useEffect(() => {
    const outlet = ref.current;
    if (outlets === null || outlet === null) return;
    return outlets.register(outlet);
  }, [outlets, ref]);
}

export interface ToastApi {
  show: (toast: ToastInput) => string;
  dismiss: (id: string) => void;
}

export function useToast(): ToastApi {
  const { show, dismiss } = useToastStore();
  return useMemo(() => ({ show, dismiss }), [show, dismiss]);
}
