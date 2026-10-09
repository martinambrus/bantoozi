import { Outlet } from '@tanstack/react-router';

import { ReaderStateProvider } from './reader-state.js';

export function ReaderLayout() {
  return (
    <ReaderStateProvider>
      <Outlet />
    </ReaderStateProvider>
  );
}
