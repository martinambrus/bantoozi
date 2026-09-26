/** OPML import and export (spec 03 §11) — M1-T6. */
export { exportOpml, type ExportOpmlOptions, type OpmlSubscription } from './export-opml.js';
export {
  OPML_MAX_BYTES,
  OPML_MAX_DEPTH,
  OPML_MAX_OUTLINES,
  parseOpml,
  type OpmlDuplicateEntry,
  type OpmlEntry,
  type OpmlImport,
  type OpmlInvalidEntry,
  type OpmlInvalidReason,
  type ParseOpmlOptions,
} from './parse-opml.js';
