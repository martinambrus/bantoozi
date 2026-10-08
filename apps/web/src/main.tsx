// zod is configured before any schema exists (src/zod-jitless.ts). Importing the app statically
// would not keep that order in the build: the schemas sit in a chunk that this module imports, and
// an imported chunk runs before the module's own code. The app is therefore loaded afterwards.
import './zod-jitless.js';

await import('./start.js');
