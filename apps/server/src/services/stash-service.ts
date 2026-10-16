/**
 * StashService - Stash operations without HTTP
 *
 * Encapsulates stash workflows including:
 * - Push (create) stashes with optional message and file selection
 * - List all stash entries with metadata and changed files
 * - Apply or pop a stash entry with conflict detection
 * - Drop (delete) a stash entry
 * - Conflict detection from command output and git diff
 * - Lifecycle event emission (start, progress, conflicts, success, failure)
 *
 * Extracted from the worktree stash route handlers to improve organisation
 * and testability. Follows the same pattern as pull-service.ts and
 * merge-service.ts.
 */

import { createLogger, getErrorMessage } from '@automaker/utils';
import type { EventEmitter } from '../lib/events.js';
import { execGitCommand, execGitCommandWithLockRetry } from '../lib/git.js';

const logger = createLogger('StashService');

// ============================================================================
// Types
// ============================================================================

export interface StashApplyOptions {
  /** When true, remove the stash entry after applying (git stash pop) */
  pop?: boolean;
}

export interface StashApplyResult {
  success: boolean;
  error?: string;
  applied?: boolean;
  hasConflicts?: boolean;
  conflictFiles?: string[];
  operation?: 'apply' | 'pop';
  stashIndex?: number;
  message?: string;
}

export interface StashPushResult {
  success: boolean;
  error?: string;
  stashed: boolean;
  branch?: string;
  message?: string;
}

export interface StashEntry {
  index: number;
  message: string;
  branch: string;
  date: string;
  files: string[];
}

export interface StashListResult {
  success: boolean;
  error?: string;
  stashes: StashEntry[];
  total: number;
}

export interface StashDropResult {
  success: boolean;
  error?: string;
  dropped: boolean;
  stashIndex?: number;
  message?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Retrieve the list of files with unmerged (conflicted) entries using git diff.
 *
 * @param worktreePath - Path to the git worktree
 * @returns Array of file paths that have unresolved conflicts
 */
export async function getConflictedFiles(worktreePath: string): Promise<string[]> {
  try {
    const diffOutput = await execGitCommand(
      ['diff', '--name-only', '--diff-filter=U'],
      worktreePath
    );
    return diffOutput
      .trim()
      .split('\n')
      .filter((f) => f.trim().length > 0);
  } catch {
    // If we cannot get the file list, return an empty array
    return [];
  }
}

/**
 * Determine whether command output indicates a merge conflict.
 */
function isConflictOutput(output: string): boolean {
  return output.includes('CONFLICT') || output.includes('Merge conflict');
}

/**
 * Build a conflict result from stash apply/pop, emit events, and return.
 * Extracted to avoid duplicating conflict handling in the try and catch paths.
 */
async function handleStashConflicts(
  worktreePath: string,
  stashIndex: number,
  operation: 'apply' | 'pop',
  events?: EventEmitter
): Promise<StashApplyResult> {
  const conflictFiles = await getConflictedFiles(worktreePath);

  events?.emit('stash:conflicts', {
    worktreePath,
    stashIndex,
    operation,
    conflictFiles,
  });

  const result: StashApplyResult = {
    success: true,
    applied: true,
    hasConflicts: true,
    conflictFiles,
    operation,
    stashIndex,
    message: `Stash ${operation === 'pop' ? 'popped' : 'applied'} with conflicts. Please resolve the conflicts.`,
  };

  events?.emit('stash:success', {
    worktreePath,
    stashIndex,
    operation,
    hasConflicts: true,
    conflictFiles,
  });

  return result;
}

// ============================================================================
// Main Service Function
// ============================================================================

/**
 * Apply or pop a stash entry in the given worktree.
 *
 * The workflow:
 * 1. Validate inputs
 * 2. Emit stash:start event
 * 3. Run `git stash apply` or `git stash pop`
 * 4. Emit stash:progress event with raw command output
 * 5. Check output for conflict markers; if conflicts found, collect files and
 *    emit stash:conflicts event
 * 6. Emit stash:success or stash:failure depending on outcome
 * 7. Return a structured StashApplyResult
 *
 * @param worktreePath  - Absolute path to the git worktree
 * @param stashIndex    - Zero-based stash index (stash@{N})
 * @param options       - Optional flags (pop)
 * @returns StashApplyResult with detailed status information
 */
export async function applyOrPop(
  worktreePath: string,
  stashIndex: number,
  options?: StashApplyOptions,
  events?: EventEmitter
): Promise<StashApplyResult> {
  const operation: 'apply' | 'pop' = options?.pop ? 'pop' : 'apply';
  const stashRef = `stash@{${stashIndex}}`;

  logger.info(`[StashService] ${operation} ${stashRef} in ${worktreePath}`);

  // 1. Emit start event
  events?.emit('stash:start', { worktreePath, stashIndex, stashRef, operation });

  try {
    // 2. Run git stash apply / pop
    let stdout = '';

    try {
      stdout = await execGitCommand(['stash', operation, stashRef], worktreePath);
    } catch (gitError: unknown) {
      const err = gitError as { stdout?: string; stderr?: string; message?: string };
      const errStdout = err.stdout || '';
      const errStderr = err.stderr || err.message || '';

      const combinedOutput = `${errStdout}\n${errStderr}`;

      // 3. Emit progress with raw output
      events?.emit('stash:progress', {
        worktreePath,
        stashIndex,
        operation,
        output: combinedOutput,
      });

      // 4. Check if the error is a conflict
      if (isConflictOutput(combinedOutput)) {
        return handleStashConflicts(worktreePath, stashIndex, operation, events);
      }

      // 5. Non-conflict git error – re-throw so the outer catch logs and handles it
      throw gitError;
    }

    // 6. Command succeeded – check stdout for conflict markers (some git versions
    //    exit 0 even when conflicts occur during apply)
    const combinedOutput = stdout;

    events?.emit('stash:progress', { worktreePath, stashIndex, operation, output: combinedOutput });

    if (isConflictOutput(combinedOutput)) {
      return handleStashConflicts(worktreePath, stashIndex, operation, events);
    }

    // 7. Clean success
    const result: StashApplyResult = {
      success: true,
      applied: true,
      hasConflicts: false,
      operation,
      stashIndex,
      message: `Stash ${operation === 'pop' ? 'popped' : 'applied'} successfully`,
    };

    events?.emit('stash:success', {
      worktreePath,
      stashIndex,
      operation,
      hasConflicts: false,
    });

    return result;
  } catch (error) {
    const errorMessage = getErrorMessage(error);

    logger.error(`Stash ${operation} failed`, { error: getErrorMessage(error) });

    events?.emit('stash:failure', {
      worktreePath,
      stashIndex,
      operation,
      error: errorMessage,
    });

    return {
      success: false,
      error: errorMessage,
      applied: false,
      operation,
      stashIndex,
    };
  }
}

// ============================================================================
// Push Stash
// ============================================================================

/**
 * Stash uncommitted changes (including untracked files) with an optional
 * message and optional file selection.
 *
 * Workflow:
 * 1. Check for uncommitted changes via `git status --porcelain`
 * 2. If no changes, return early with stashed: false
 * 3. Build and run `git stash push --include-untracked [-m message] [-- files]`
 * 4. Retrieve the current branch name
 * 5. Return a structured StashPushResult
 *
 * @param worktreePath - Absolute path to the git worktree
 * @param options      - Optional message and files to selectively stash
 * @returns StashPushResult with stash status and branch info
 */
export async function pushStash(
  worktreePath: string,
  options?: { message?: string; files?: string[] },
  events?: EventEmitter
): Promise<StashPushResult> {
  const message = options?.message;
  const files = options?.files;

  logger.info(`[StashService] push stash in ${worktreePath}`);
  events?.emit('stash:start', { worktreePath, operation: 'push' });

  // 1. Check for any changes to stash
  const status = await execGitCommand(['status', '--porcelain'], worktreePath);

  if (!status.trim()) {
    events?.emit('stash:success', { worktreePath, operation: 'push', stashed: false });
    return {
      success: true,
      stashed: false,
      message: 'No changes to stash',
    };
  }

  // 2. Build stash push command args
  const args = ['stash', 'push', '--include-untracked'];
  if (message && message.trim()) {
    args.push('-m', message.trim());
  }

  // If specific files are provided, add them as pathspecs after '--'
  if (files && files.length > 0) {
    args.push('--');
    args.push(...files);
  }

  // 3. Execute stash push (with automatic index.lock cleanup and retry)
  await execGitCommandWithLockRetry(args, worktreePath);

  // 4. Get current branch name
  const branchOutput = await execGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  const branchName = branchOutput.trim();

  events?.emit('stash:success', {
    worktreePath,
    operation: 'push',
    stashed: true,
    branch: branchName,
  });

  return {
    success: true,
    stashed: true,
    branch: branchName,
    message: message?.trim() || `WIP on ${branchName}`,
  };
}

// ============================================================================
// List Stashes
// ============================================================================

/**
 * List all stash entries for a worktree with metadata and changed files.
 *
 * Workflow:
 * 1. Run `git stash list` with a custom format to get index, message, and date
 * 2. Parse each stash line into a structured StashEntry
 * 3. For each entry, fetch the list of files changed via `git stash show`
 * 4. Return the full list as a StashListResult
 *
 * @param worktreePath - Absolute path to the git worktree
 * @returns StashListResult with all stash entries and their metadata
 */
export async function listStash(worktreePath: string): Promise<StashListResult> {
  logger.info(`[StashService] list stashes in ${worktreePath}`);

  // 1. Get stash list with format: index, message, date
  // Use %aI (strict ISO 8601) instead of %ai to ensure cross-browser compatibility
  const stashOutput = await execGitCommand(
    ['stash', 'list', '--format=%gd|||%s|||%aI'],
    worktreePath
  );

  if (!stashOutput.trim()) {
    return {
      success: true,
      stashes: [],
      total: 0,
    };
  }

  const stashLines = stashOutput
    .trim()
    .split('\n')
    .filter((l) => l.trim());
  const stashes: StashEntry[] = [];

  for (const line of stashLines) {
    const parts = line.split('|||');
    if (parts.length < 3) continue;

    const refSpec = parts[0].trim(); // e.g., "stash@{0}"
    // The user's message can contain the separator; only the outer fields have
    // fixed formats (stash ref and ISO date), so preserve every middle segment.
    const stashMessage = parts.slice(1, -1).join('|||').trim();
    const date = parts[parts.length - 1].trim();

    // Extract index from stash@{N}; skip entries that don't match the expected format
    const indexMatch = refSpec.match(/stash@\{(\d+)\}/);
    if (!indexMatch) continue;
    const index = parseInt(indexMatch[1], 10);

    // Extract branch name from message (format: "WIP on branch: hash message" or "On branch: hash message")
    let branch = '';
    const branchMatch = stashMessage.match(/^(?:WIP on|On) ([^:]+):/);
    if (branchMatch) {
      branch = branchMatch[1];
    }

    // Get list of files in this stash
    let files: string[] = [];
    try {
      const filesOutput = await execGitCommand(
        ['stash', 'show', refSpec, '--name-only'],
        worktreePath
      );
      files = filesOutput
        .trim()
        .split('\n')
        .filter((f) => f.trim());
    } catch {
      // Ignore errors getting file list
    }

    stashes.push({
      index,
      message: stashMessage,
      branch,
      date,
      files,
    });
  }

  return {
    success: true,
    stashes,
    total: stashes.length,
  };
}

// ============================================================================
// Drop Stash
// ============================================================================

/**
 * Drop (delete) a stash entry by index.
 *
 * @param worktreePath - Absolute path to the git worktree
 * @param stashIndex   - Zero-based stash index (stash@{N})
 * @returns StashDropResult with drop status
 */
export async function dropStash(
  worktreePath: string,
  stashIndex: number,
  events?: EventEmitter
): Promise<StashDropResult> {
  const stashRef = `stash@{${stashIndex}}`;

  logger.info(`[StashService] drop ${stashRef} in ${worktreePath}`);
  events?.emit('stash:start', { worktreePath, stashIndex, stashRef, operation: 'drop' });

  await execGitCommand(['stash', 'drop', stashRef], worktreePath);

  events?.emit('stash:success', { worktreePath, stashIndex, stashRef, operation: 'drop' });

  return {
    success: true,
    dropped: true,
    stashIndex,
    message: `Stash ${stashRef} dropped successfully`,
  };
}
