/**
 * API repositories (spec 08): the SQL behind `apps/api` routes. Tenant-owned queries take a
 * {@link TenantTx}; auth/control-plane functions take an executor and filter by the authenticated
 * user explicitly (spec 02 §1.2 exceptions).
 */
export * from './admin.js';
export * from './article-actions.js';
export * from './articles.js';
export * from './auth.js';
export * from './library.js';
export * from './me.js';
export * from './mutations.js';
export * from './quotas.js';
export * from './rate-limit.js';
export * from './rules.js';
export * from './sessions.js';
export * from './subscriptions.js';
