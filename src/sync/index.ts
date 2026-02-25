/**
 * Sync layer — Git-based knowledge sharing.
 *
 * Entries are stored as Markdown files with YAML frontmatter in a git repo.
 * Links are embedded in entry frontmatter (no separate link files).
 * SQLite is a local index/cache enriched with personal memory data.
 * Content syncs; access_count/last_accessed_at stay local.
 */

export { setSyncConfig, getSyncConfig, isSyncEnabled, isSyncInProgress, setSyncInProgress, tryAcquireSyncLock, releaseSyncLock, SYNC_SCHEMA_VERSION } from './config.js';
export type { SyncConfig, SyncRepoConfig } from './routing.js';
export { loadSyncConfig, resolveRepo } from './routing.js';
export {
  entryToJSON, parseEntryJSON, linkToJSON, parseLinkJSON,
  entryToMarkdown, parseEntryMarkdown, entryFileName, titleToSlug, id8,
  buildRedirectMarker, parseRedirect,
  deterministicLinkId,
  ENTRY_FILENAME_RE,
} from './serialize.js';
export type { EntryJSON, LinkJSON, FrontmatterLink } from './serialize.js';
export { pull } from './pull.js';
export type { PullResult, ConflictDetail } from './pull.js';
export { push } from './push.js';
export type { PushResult } from './push.js';
export { syncWriteEntry, syncWriteEntryWithLinks, syncDeleteEntry, touchedRepos, clearTouchedRepos } from './write-through.js';
export { scheduleCommit, flushCommit, hasPendingCommit, COMMIT_DEBOUNCE_MS } from './commit-scheduler.js';
export {
  ensureRepoStructure,
  entryFilePath,
  findEntryFile,
  writeEntryFile,
  readEntryFileRaw,
  deleteEntryFile,
  readAllEntryFiles,
  readAllLinkFiles,
  getRepoEntryIds,
  cleanupRedirectFiles,
  cleanupLinksDirectory,
  migrateLinkFilesToFrontmatter,
  migrateJsonToMarkdown,
} from './fs.js';
export { detectConflict } from './merge.js';
export type { MergeResult } from './merge.js';
export { gitInit, gitCommitAll, gitPull, gitPush, isGitRepo, hasRemote, gitClone, gitAddRemote, gitFileLog, gitShowFile } from './git.js';
export type { GitLogEntry } from './git.js';
export { getEntryHistory, getEntryAtCommit, getEntryAtCommitWithParent } from './history.js';
export type { HistoryCommit, CommitWithParent } from './history.js';
