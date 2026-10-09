import { z } from 'zod';

// The production CSP has no 'unsafe-eval' (spec 11 §7): stop zod 4 from probing `new Function`, which
// reports a violation on every page load. main.tsx imports it before it loads the rest of the app.
z.config({ jitless: true });
