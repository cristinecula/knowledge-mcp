/**
 * Sync layer — Git-based knowledge sharing.
 *
 * JSON files in a git repo are the canonical shared data.
 * SQLite is a local index/cache enriched with personal memory data.
 * Content syncs; strength/access_count/last_accessed_at stay local.
 */

export { setSyncConfig, getSyncConfig, isSyncEnabled, SYNC_SCHEMA_VERSION } from './config.js';
export type { SyncConfig, SyncRepoConfig } from './routing.js';
export { loadSyncConfig, resolveRepo } from './routing.js';
export { entryToJSON, parseEntryJSON, linkToJSON, parseLinkJSON } from './serialize.js';
export type { EntryJSON, LinkJSON } from './serialize.js';
export { pull } from './pull.js';
export type { PullResult, ConflictDetail } from './pull.js';
export { push } from './push.js';
export type { PushResult } from './push.js';
export { syncWriteEntry, syncWriteLink, syncDeleteEntry, syncDeleteLink, touchedRepos, clearTouchedRepos } from './write-through.js';
export {
  ensureRepoStructure,
  writeEntryFile,
  writeLinkFile,
  deleteEntryFile,
  deleteLinkFile,
  readAllEntryFiles,
  readAllLinkFiles,
  getRepoEntryIds,
  getRepoLinkIds,
} from './fs.js';
export { detectConflict } from './merge.js';
export type { MergeResult } from './merge.js';
export { gitInit, gitCommitAll, gitPull, gitPush, isGitRepo, hasRemote, gitClone, gitAddRemote } from './git.js';
