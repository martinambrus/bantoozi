/**
 * Protected input of an API key for the credentials CLI (spec 04 §1.2): never from argv or the
 * environment of the command. On a terminal the key is typed or pasted with echo disabled (raw
 * mode, nothing written back but the prompt and a final newline); from a pipe or redirect
 * (`credentials:stage typesafe < key.txt`) it is the whole input with one trailing line break
 * removed. Errors never contain the input.
 */

/** Longest accepted input; the key itself is limited to 4 KiB by `validateProviderSecret`. */
export const MAX_SECRET_INPUT_BYTES = 16 * 1024;

export interface SecretInputStream extends AsyncIterable<string | Buffer> {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  off(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  off(event: 'end' | 'close', listener: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface PromptOutput {
  write(text: string): unknown;
}

export type SecretInputErrorCode = 'cancelled' | 'input_too_large';

export class SecretInputError extends Error {
  readonly code: SecretInputErrorCode;
  constructor(code: SecretInputErrorCode) {
    super(code === 'cancelled' ? 'Input cancelled' : 'Input exceeds 16 KiB');
    this.name = 'SecretInputError';
    this.code = code;
  }
}

/** Read one secret: echo-free from a terminal, or the whole piped input. */
export async function readSecret(
  input: SecretInputStream,
  prompt: PromptOutput,
  promptText: string,
): Promise<string> {
  const { setRawMode } = input;
  if (input.isTTY === true && typeof setRawMode === 'function') {
    return readFromTerminal(input, (mode) => setRawMode.call(input, mode), prompt, promptText);
  }
  return readPiped(input);
}

async function readPiped(input: SecretInputStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += buffer.length;
      if (size > MAX_SECRET_INPUT_BYTES) throw new SecretInputError('input_too_large');
      chunks.push(Buffer.from(buffer));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    // One line break from `echo`, a heredoc or an editor is not part of the key.
    if (text.endsWith('\r\n')) return text.slice(0, -2);
    if (text.endsWith('\n')) return text.slice(0, -1);
    return text;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function readFromTerminal(
  input: SecretInputStream,
  setRawMode: (mode: boolean) => unknown,
  prompt: PromptOutput,
  promptText: string,
): Promise<string> {
  prompt.write(promptText);
  setRawMode(true);
  input.resume();
  let value = '';
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (error?: SecretInputError): void => {
      if (done) return;
      done = true;
      input.off('data', onData);
      input.off('end', onEnd);
      setRawMode(false);
      input.pause();
      prompt.write('\n');
      if (error === undefined) resolve(value);
      else {
        value = '';
        reject(error);
      }
    };
    const onEnd = (): void => finish();
    const onData = (chunk: string | Buffer): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const char of text) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish();
        if (char === '\u0003') return finish(new SecretInputError('cancelled'));
        if (char === '\u007f' || char === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        value += char;
        if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_INPUT_BYTES) {
          return finish(new SecretInputError('input_too_large'));
        }
      }
      return undefined;
    };
    input.on('data', onData);
    input.on('end', onEnd);
  });
}
