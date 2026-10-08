import { useState, type Dispatch, type SetStateAction } from 'react';
import type { RegisterSWOptions } from 'virtual:pwa-register/react';
import { vi, type Mock } from 'vitest';

/** One registration the app asked for, with the means to play the library's side of it. */
export interface FakeLibrary {
  options: RegisterSWOptions;
  updateServiceWorker: Mock<(reloadPage?: boolean) => Promise<void>>;
  /** A new worker has installed and is waiting. */
  waiting: () => void;
  registered: (registration: ServiceWorkerRegistration | undefined) => void;
  failed: (error: unknown) => void;
  /** The waiting worker took control of the page, whoever asked it to. */
  tookControl: () => void;
}

/** Every registration the app asked for since the last `libraries.length = 0`. */
export const libraries: FakeLibrary[] = [];

function createLibrary(
  options: RegisterSWOptions,
  setNeedRefresh: Dispatch<SetStateAction<boolean>>,
): FakeLibrary {
  const library: FakeLibrary = {
    options,
    updateServiceWorker: vi.fn(async () => {
      library.tookControl();
    }),
    waiting() {
      setNeedRefresh(true);
      options.onNeedRefresh?.();
    },
    registered(registration) {
      options.onRegisteredSW?.('/sw.js', registration);
    },
    failed(error) {
      options.onRegisterError?.(error);
    },
    tookControl() {
      if (options.onNeedReload === undefined) window.location.reload();
      else options.onNeedReload();
    },
  };
  return library;
}

/**
 * The hook of `virtual:pwa-register/react` as the plugin generates it for a build: the options of
 * the first render reach the library, once per mount, and the library reloads the page when a
 * worker takes control unless `onNeedReload` takes that over. (Under test the plugin supplies a
 * stub that never registers anything.)
 */
export function useRegisterSW(options: RegisterSWOptions = {}) {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [library] = useState(() => {
    const created = createLibrary(options, setNeedRefresh);
    libraries.push(created);
    return created;
  });
  return {
    needRefresh: [needRefresh, setNeedRefresh] as [boolean, Dispatch<SetStateAction<boolean>>],
    offlineReady: [offlineReady, setOfflineReady] as [boolean, Dispatch<SetStateAction<boolean>>],
    updateServiceWorker: library.updateServiceWorker,
  };
}
