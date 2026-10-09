import { ErrorComponent, type ErrorComponentProps } from '@tanstack/react-router';

import { OfflineStartupError } from '../../session/offline-start.js';
import { OfflineStartScreen } from './offline-start-screen.js';

/** The router's error screen: a start without a connection gets its own, every other error as before. */
export function RouteError(props: ErrorComponentProps) {
  return props.error instanceof OfflineStartupError ? (
    <OfflineStartScreen />
  ) : (
    <ErrorComponent {...props} />
  );
}
