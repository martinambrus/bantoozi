import type { Page } from '@playwright/test';

/**
 * The key presses the page's own handlers have already seen: a listener on `window` runs after
 * every handler of the document, so `prevented` says whether one of them took the key.
 */
export interface SeenKey {
  key: string;
  code: string;
  keyCode: number;
  ctrl: boolean;
  meta: boolean;
  composing: boolean;
  prevented: boolean;
}

interface KeyLog {
  keys: SeenKey[];
}

/** Starts recording; the modifier keys themselves are left out. */
export async function recordKeys(page: Page): Promise<void> {
  await page.evaluate(() => {
    const holder = window as typeof window & { __pwaKeys?: KeyLog };
    const log: KeyLog = { keys: [] };
    holder.__pwaKeys = log;
    window.addEventListener('keydown', (event) => {
      if (['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return;
      log.keys.push({
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        composing: event.isComposing,
        prevented: event.defaultPrevented,
      });
    });
  });
}

/** The keys seen since the recording began or this was last called. */
export async function takeKeys(page: Page): Promise<SeenKey[]> {
  return page.evaluate(() => {
    const holder = window as typeof window & { __pwaKeys?: KeyLog };
    if (holder.__pwaKeys === undefined) throw new Error('the keys are not being recorded');
    return holder.__pwaKeys.keys.splice(0);
  });
}

/**
 * Types letters the way an input method does: each one is a key event of code 229 ("Process")
 * while the text so far stays an open composition, which `commit` then replaces with the text the
 * person chose. The page sees composition events and the field the committed text.
 */
export async function typeWithInputMethod(
  page: Page,
  letters: readonly string[],
  commit: string,
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    let composition = '';
    for (const letter of letters) {
      const code = `Key${letter.toUpperCase()}`;
      await session.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        windowsVirtualKeyCode: 229,
        key: 'Process',
        code,
      });
      composition += letter;
      await session.send('Input.imeSetComposition', {
        text: composition,
        selectionStart: composition.length,
        selectionEnd: composition.length,
      });
      await session.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: 229,
        key: 'Process',
        code,
      });
    }
    await session.send('Input.insertText', { text: commit });
  } finally {
    await session.detach();
  }
}
