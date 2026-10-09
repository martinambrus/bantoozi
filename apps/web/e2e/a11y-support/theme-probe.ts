export interface ThemeState {
  readyState: string;
  dark: boolean;
  colorScheme: string;
}

export interface ThemeProbe {
  /** The theme of `<html>` each time the document's readyState changed. */
  states: ThemeState[];
  /** The theme of `<html>` at the first animation frame, which is the first paint. */
  firstFrame: ThemeState | null;
  /** Every Content-Security-Policy violation the document reported. */
  violations: string[];
}

/**
 * Runs in the page before any of its own scripts (`addInitScript`): stores the theme the person
 * chose, as an earlier visit would have, and notes what `<html>` looks like at each stage of the
 * load. The app's own module script runs after `interactive`, so what is noted there was done by
 * the script in the head.
 */
export function installThemeProbe(stored: string): void {
  try {
    window.localStorage.setItem('bantoozi:theme', stored);
  } catch {
    // A page without storage is not the one under test.
  }
  const stateNow = (): ThemeState => ({
    readyState: document.readyState,
    dark: document.documentElement.classList.contains('dark'),
    colorScheme: document.documentElement.style.colorScheme,
  });
  const probe: ThemeProbe = { states: [], firstFrame: null, violations: [] };
  (window as typeof window & { __themeProbe?: ThemeProbe }).__themeProbe = probe;
  document.addEventListener('readystatechange', () => probe.states.push(stateNow()));
  document.addEventListener('securitypolicyviolation', (event) => {
    const at = `${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`;
    probe.violations.push(`${event.violatedDirective} blocked ${event.blockedURI} at ${at}`);
  });
  const paint = () => {
    // Before the parser has made `<html>` there is nothing to paint.
    if (document.documentElement === null) requestAnimationFrame(paint);
    else probe.firstFrame = stateNow();
  };
  requestAnimationFrame(paint);
}

export function readThemeProbe(): ThemeProbe | undefined {
  return (window as typeof window & { __themeProbe?: ThemeProbe }).__themeProbe;
}
