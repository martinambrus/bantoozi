import { z } from 'zod';

// The production CSP has no 'unsafe-eval' (spec 11 §7): stop zod 4 from probing `new Function`, which
// reports a violation on every page load. Imported first in main.tsx, before any schema module.
z.config({ jitless: true });
