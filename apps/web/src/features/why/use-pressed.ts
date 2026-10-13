import { useEffect, useState } from 'react';

/**
 * Which of several buttons that share one pending request was pressed, so only that one shows the
 * spinner while the others are merely disabled. It forgets the press when the request is done.
 */
export function usePressed<Key>(pending: boolean): {
  pressed: Key | null;
  press: (key: Key) => void;
} {
  const [pressed, setPressed] = useState<Key | null>(null);
  useEffect(() => {
    if (!pending) setPressed(null);
  }, [pending]);
  return { pressed: pending ? pressed : null, press: setPressed };
}
