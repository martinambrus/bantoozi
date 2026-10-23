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
import {
  useEstimateNoticeState,
  type EstimateNoticeControl,
} from '../learning/use-estimate-notice.js';
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
  estimateNotice: EstimateNoticeControl;
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
  const estimateNotice = useEstimateNoticeState();
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
    () => ({
      everythingOpen,
      setEverythingOpen,
      settings,
      feedFilter,
      setFeedFilter,
      targets,
      estimateNotice,
    }),
    [everythingOpen, settings, feedFilter, targets, estimateNotice],
  );
  return <ReaderStateContext value={value}>{children}</ReaderStateContext>;
}

/** The wait for the estimate refresh that follows the reader's ratings; it outlives a change of view. */
export function useEstimateNotice(): EstimateNoticeControl {
  return useReaderState().estimateNotice;
}

/** Tells the notice that the reader rated; does nothing outside the reader. */
export function useArmEstimateNotice(): () => void {
  const state = useContext(ReaderStateContext);
  return state === null ? noop : state.estimateNotice.arm;
}

function noop() {}

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
