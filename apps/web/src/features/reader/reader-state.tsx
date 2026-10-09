import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { errorMessage } from '../../components/error-message.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useSession } from '../../session/context.js';
import { createSettingsWriter, type SettingsWriter } from './settings-writer.js';
import { createTargets, type ReaderTargets } from './shortcuts/targets.js';

interface ReaderState {
  /** Whether the Everything else lane shows in the sidebar. */
  everythingOpen: boolean;
  setEverythingOpen: Dispatch<SetStateAction<boolean>>;
  settings: SettingsWriter;
  /** What was typed into the filter of the sidebar's feeds. */
  feedFilter: string;
  setFeedFilter: Dispatch<SetStateAction<string>>;
  targets: ReaderTargets;
}

const ReaderStateContext = createContext<ReaderState | null>(null);

/**
 * What outlives a move from a lane to a feed, a folder or a label, which are different routes and
 * so show a new page: the sidebar's folded lane and feed filter, the settings that are still being
 * saved, and the controls the keyboard shortcuts reach.
 */
export function ReaderStateProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const session = useSession();
  const toast = useToast();
  const { i18n } = useTranslation();
  const [everythingOpen, setEverythingOpen] = useState(true);
  const [feedFilter, setFeedFilter] = useState('');
  const [targets] = useState(createTargets);
  const [settings] = useState(() =>
    createSettingsWriter({
      api,
      queryClient,
      currentSignIn: session.currentSignIn,
      onRefused: (error) => toast.show({ message: errorMessage(i18n.t, error), tone: 'error' }),
    }),
  );
  const value = useMemo(
    () => ({ everythingOpen, setEverythingOpen, settings, feedFilter, setFeedFilter, targets }),
    [everythingOpen, settings, feedFilter, targets],
  );
  return <ReaderStateContext value={value}>{children}</ReaderStateContext>;
}

function useReaderState(): ReaderState {
  const state = useContext(ReaderStateContext);
  if (state === null) throw new Error('The reader needs a <ReaderStateProvider> above it');
  return state;
}

export function useEverythingOpen(): [boolean, Dispatch<SetStateAction<boolean>>] {
  const { everythingOpen, setEverythingOpen } = useReaderState();
  return [everythingOpen, setEverythingOpen];
}

export function useSettingsWriter(): SettingsWriter {
  return useReaderState().settings;
}

export function useFeedFilter(): [string, Dispatch<SetStateAction<string>>] {
  const { feedFilter, setFeedFilter } = useReaderState();
  return [feedFilter, setFeedFilter];
}

export function useReaderTargets(): ReaderTargets {
  return useReaderState().targets;
}
