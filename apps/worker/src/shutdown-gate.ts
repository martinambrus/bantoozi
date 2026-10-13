/**
 * The drain the runtime calls before a settings self-restart exit. `main.ts` creates it before the
 * runtime exists but wires the real shutdown only once start-up is complete; a drain requested in
 * between waits for the wiring instead of letting the process exit with consumers still undrained.
 */
export interface ShutdownGate {
  /** Resolves when the wired shutdown has finished (waiting for the wiring if needed). */
  drain(signal: string): Promise<void>;
  /** Wires the real shutdown; releases any waiting drain. */
  wire(shutdown: (signal: string) => Promise<void>): void;
}

export function createShutdownGate(): ShutdownGate {
  let release!: (shutdown: (signal: string) => Promise<void>) => void;
  const wired = new Promise<(signal: string) => Promise<void>>((resolve) => {
    release = resolve;
  });
  return {
    drain: async (signal) => (await wired)(signal),
    wire: (shutdown) => release(shutdown),
  };
}
