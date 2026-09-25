import { defineConfig } from 'drizzle-kit';

// drizzle-kit generates the table/index/constraint SQL from src/schema; RLS policies, grants,
// functions, triggers and storage settings are hand-written custom migrations (spec 02, intro).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
