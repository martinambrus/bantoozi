import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { createToastStore, type ToastInput, type ToastStore } from './toast-store.js';

const ToastContext = createContext<ToastStore | null>(null);

export interface ToastProviderProps {
  /** A store created outside React, to show toasts from query-cache callbacks for instance. */
  store?: ToastStore | undefined;
  children: ReactNode;
}

export function ToastProvider({ store, children }: ToastProviderProps) {
  const [ownStore] = useState(createToastStore);
  return <ToastContext value={store ?? ownStore}>{children}</ToastContext>;
}

export function useToastStore(): ToastStore {
  const store = useContext(ToastContext);
  if (store === null) throw new Error('Toasts need a <ToastProvider> above them');
  return store;
}

export interface ToastApi {
  show: (toast: ToastInput) => string;
  dismiss: (id: string) => void;
}

export function useToast(): ToastApi {
  const { show, dismiss } = useToastStore();
  return useMemo(() => ({ show, dismiss }), [show, dismiss]);
}
