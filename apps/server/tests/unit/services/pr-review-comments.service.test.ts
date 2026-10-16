import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const commands = vi.hoisted(() => ({ spawn: vi.fn(), rest: vi.fn() }));
vi.mock('child_process', () => ({
  spawn: commands.spawn,
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: commands.rest,
  }),
}));

import {
  fetchPRReviewComments,
  fetchReviewThreadResolvedStatus,
} from '../../../src/services/pr-review-comments.service.js';

const root = '/registered project';
const graphqlRequests: Array<{
  variables: { cursor: string | null; owner: string; repo: string; prNumber: number };
  query: string;
}> = [];
let graphReplies: Array<unknown>;
let restReplies: Record<string, unknown>;
let kill: ReturnType<typeof vi.fn>;

function threads(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      repository: {
        pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } } },
      },
    },
  };
}

function thread(id: string, isResolved: boolean, ids: number[], hasMoreComments = false) {
  return {
    id,
    isResolved,
    comments: {
      nodes: ids.map((databaseId) => ({ databaseId })),
      pageInfo: { hasNextPage: hasMoreComments },
    },
  };
}

beforeEach(() => {
  graphqlRequests.length = 0;
  graphReplies = [threads([])];
  restReplies = {};
  kill = vi.fn();
  commands.rest.mockImplementation(async (_command: string, args: string[]) => {
    const value = Object.prototype.hasOwnProperty.call(restReplies, args[1])
      ? restReplies[args[1]]
      : [];
    if (value instanceof Error) throw value;
    return { stdout: JSON.stringify(value), stderr: '' };
  });
  commands.spawn.mockImplementation(() => {
    const process = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    process.stdout = new EventEmitter();
    process.stderr = new EventEmitter();
    process.stdin = Object.assign(new EventEmitter(), {
      write: vi.fn((body: string) => graphqlRequests.push(JSON.parse(body))),
      end: vi.fn(() => {
        const response = graphReplies.shift();
        queueMicrotask(() => {
          if (response === 'timeout') return;
          if (response instanceof Error) {
            process.emit('error', response);
            return;
          }
          if (response === 'exit-failure') {
            process.stderr.emit('data', Buffer.from('access denied'));
            process.emit('close', 1);
            return;
          }
          process.stdout.emit(
            'data',
            Buffer.from(response === 'invalid-json' ? 'invalid JSON' : JSON.stringify(response))
          );
          process.emit('close', 0);
        });
      }),
    });
    process.kill = kill;
    return process;
  });
});

afterEach(() => vi.useRealTimers());

describe('PR review thread resolution', () => {
  it('joins every comment to the correct thread across GraphQL cursor pages', async () => {
    graphReplies = [
      threads([thread('thread-a', true, [11, 12], true)], true, 'cursor-one'),
      threads([thread('thread-b', false, [13])]),
    ];
    const statuses = await fetchReviewThreadResolvedStatus(root, 'owner', 'repository', 7);
    expect([...statuses.entries()]).toEqual([
      ['11', { isResolved: true, threadId: 'thread-a' }],
      ['12', { isResolved: true, threadId: 'thread-a' }],
      ['13', { isResolved: false, threadId: 'thread-b' }],
    ]);
    expect(graphqlRequests.map(({ variables }) => variables)).toEqual([
      { owner: 'owner', repo: 'repository', prNumber: 7, cursor: null },
      { owner: 'owner', repo: 'repository', prNumber: 7, cursor: 'cursor-one' },
    ]);
    expect(commands.spawn).toHaveBeenCalledWith(
      'gh',
      ['api', 'graphql', '--input', '-'],
      expect.objectContaining({ cwd: root })
    );
  });

  it('retains already fetched statuses if a later pagination request fails', async () => {
    graphReplies = [
      threads([thread('first', true, [1])], true, 'next'),
      { errors: [{ message: 'rate limited' }] },
    ];
    expect([...(await fetchReviewThreadResolvedStatus(root, 'owner', 'repo', 1))]).toEqual([
      ['1', { isResolved: true, threadId: 'first' }],
    ]);
  });

  it.each([
    {},
    { data: {} },
    { data: { repository: {} } },
    { data: { repository: { pullRequest: null } } },
  ])(
    'handles a missing or inaccessible PR response without inventing resolution (%j)',
    async (response) => {
      graphReplies = [response];
      expect((await fetchReviewThreadResolvedStatus(root, 'owner', 'repo', 1)).size).toBe(0);
    }
  );

  it('stops pagination when GitHub claims a next page but provides no cursor', async () => {
    graphReplies = [threads([thread('first', false, [1])], true, null)];
    expect((await fetchReviewThreadResolvedStatus(root, 'owner', 'repo', 1)).size).toBe(1);
    expect(commands.spawn).toHaveBeenCalledTimes(1);
  });

  it('bounds a nonterminating pagination response to 20 requests', async () => {
    graphReplies = Array.from({ length: 20 }, (_, index) =>
      threads([thread(`thread-${index}`, false, [index])], true, `cursor-${index}`)
    );
    expect((await fetchReviewThreadResolvedStatus(root, 'owner', 'repo', 1)).size).toBe(20);
    expect(commands.spawn).toHaveBeenCalledTimes(20);
    expect(graphReplies).toHaveLength(0);
  });

  it.each([
    new Error('gh not installed'),
    'exit-failure',
    'invalid-json',
    { errors: [{ message: 'permission denied' }] },
  ])('keeps thread status optional if the provider fails (%s)', async (response) => {
    graphReplies = [response];
    expect((await fetchReviewThreadResolvedStatus(root, 'owner', 'repo', 1)).size).toBe(0);
  });

  it('kills a timed-out GraphQL command and returns unavailable resolution evidence', async () => {
    vi.useFakeTimers();
    graphReplies = ['timeout'];
    const pending = fetchReviewThreadResolvedStatus(root, 'owner', 'repo', 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).size).toBe(0);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe('PR comment reconciliation', () => {
  it('combines all three comment sources in newest-first order and enriches only inline comments', async () => {
    graphReplies = [threads([thread('resolved-thread', true, [20])])];
    restReplies = {
      'repos/owner/repo/issues/7/comments': [
        {
          id: 10,
          user: { login: 'author', avatar_url: 'https://example.invalid/avatar', type: 'User' },
          body: 'Issue comment',
          created_at: '2026-10-15T10:00:00Z',
          updated_at: '2026-10-15T10:01:00Z',
        },
      ],
      'repos/owner/repo/pulls/7/comments': [
        {
          id: 20,
          user: { login: 'reviewer', type: 'User' },
          body: 'Inline review',
          path: 'src/main.ts',
          line: 0,
          original_line: 12,
          position: null,
          created_at: '2026-10-15T12:00:00Z',
          diff_hunk: '@@ -1 +1 @@',
          side: 'RIGHT',
          commit_id: 'head-sha',
        },
      ],
      'repos/owner/repo/pulls/7/reviews': [
        {
          id: 30,
          user: { login: 'senior', type: 'User' },
          body: 'Review summary',
          state: 'APPROVED',
          submitted_at: '2026-10-15T11:00:00Z',
        },
        { id: 31, body: '', state: 'APPROVED' },
        { id: 32, body: '  ', state: 'COMMENTED' },
        { id: 33, body: 'Unpublished draft', state: 'PENDING' },
        { id: 34, state: 'APPROVED' },
      ],
    };
    const comments = await fetchPRReviewComments(root, 'owner', 'repo', 7);
    expect(comments.map(({ id }) => id)).toEqual(['20', 'review-30', '10']);
    expect(comments[0]).toMatchObject({
      author: 'reviewer',
      line: 0,
      path: 'src/main.ts',
      isReviewComment: true,
      isOutdated: true,
      isResolved: true,
      threadId: 'resolved-thread',
      diffHunk: '@@ -1 +1 @@',
      side: 'RIGHT',
      commitId: 'head-sha',
      isBot: false,
    });
    expect(comments[1]).toMatchObject({
      author: 'senior',
      isReviewComment: false,
      isResolved: false,
    });
    expect(comments[2]).toMatchObject({
      author: 'author',
      avatarUrl: 'https://example.invalid/avatar',
      isReviewComment: false,
      isResolved: false,
    });
    for (const [, args, options] of commands.rest.mock.calls) {
      expect(args).toContain('--paginate');
      expect(options).toMatchObject({ cwd: root, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
    }
  });

  it('preserves bot/app attribution and original line when current position is missing', async () => {
    restReplies = {
      'repos/owner/repo/issues/7/comments': [
        {
          id: 1,
          user: null,
          performed_via_github_app: { slug: 'ci-app' },
          body: 'app comment',
          created_at: '2026-10-15T10:00:00Z',
        },
        { id: 2, user: null, body: 'deleted author', created_at: '2026-10-15T10:00:00Z' },
      ],
      'repos/owner/repo/pulls/7/comments': [
        {
          id: 3,
          user: { login: 'review-bot', type: 'Bot' },
          body: 'bot review',
          path: 'file.ts',
          original_line: 9,
          position: 3,
          created_at: '2026-10-15T11:00:00Z',
        },
        {
          id: 4,
          user: null,
          performed_via_github_app: { slug: 'review-app' },
          body: 'app review',
          path: 'file.ts',
          created_at: '2026-10-15T11:00:00Z',
        },
        {
          id: 5,
          user: null,
          body: 'deleted reviewer',
          path: 'file.ts',
          created_at: '2026-10-15T11:00:00Z',
        },
      ],
      'repos/owner/repo/pulls/7/reviews': [
        {
          id: 6,
          user: null,
          performed_via_github_app: { slug: 'summary-app' },
          body: 'summary',
          state: 'COMMENTED',
          submitted_at: '2026-10-15T12:00:00Z',
        },
        {
          id: 7,
          user: null,
          body: 'unknown summary',
          state: 'COMMENTED',
          submitted_at: '2026-10-15T12:00:00Z',
        },
        {
          id: 8,
          user: { login: 'summary-bot', type: 'Bot' },
          body: 'bot summary',
          state: 'COMMENTED',
          submitted_at: '2026-10-15T12:00:00Z',
        },
      ],
    };
    const comments = await fetchPRReviewComments(root, 'owner', 'repo', 7);
    const byId = Object.fromEntries(comments.map((comment) => [comment.id, comment]));
    expect(byId['1']).toMatchObject({ author: 'ci-app', isBot: true });
    expect(byId['2']).toMatchObject({ author: 'unknown', isBot: false });
    expect(byId['3']).toMatchObject({
      author: 'review-bot',
      isBot: true,
      line: 9,
      isOutdated: false,
      isResolved: false,
    });
    expect(byId['4']).toMatchObject({ author: 'review-app', isBot: true });
    expect(byId['5']).toMatchObject({ author: 'unknown', isBot: false });
    expect(byId['review-6']).toMatchObject({ author: 'summary-app', isBot: true });
    expect(byId['review-7']).toMatchObject({ author: 'unknown', isBot: false });
    expect(byId['review-8']).toMatchObject({ author: 'summary-bot', isBot: true });
  });

  it.each(['issues/7/comments', 'pulls/7/comments', 'pulls/7/reviews'])(
    'preserves other sources when %s fails',
    async (failedSource) => {
      restReplies = {
        'repos/owner/repo/issues/7/comments': [
          { id: 1, user: null, body: 'issue', created_at: '2026-10-15T10:00:00Z' },
        ],
        'repos/owner/repo/pulls/7/comments': [
          { id: 2, user: null, body: 'inline', created_at: '2026-10-15T10:00:00Z' },
        ],
        'repos/owner/repo/pulls/7/reviews': [
          {
            id: 3,
            user: null,
            body: 'summary',
            state: 'APPROVED',
            submitted_at: '2026-10-15T10:00:00Z',
          },
        ],
      };
      restReplies[`repos/owner/repo/${failedSource}`] = new Error('provider unavailable');
      expect(await fetchPRReviewComments(root, 'owner', 'repo', 7)).toHaveLength(2);
    }
  );

  it('treats non-array source payloads as unavailable comments rather than fabricated rows', async () => {
    restReplies = {
      'repos/owner/repo/issues/7/comments': { message: 'not an array' },
      'repos/owner/repo/pulls/7/comments': null,
      'repos/owner/repo/pulls/7/reviews': {},
    };
    expect(await fetchPRReviewComments(root, 'owner', 'repo', 7)).toEqual([]);
  });

  it('keeps inline comments unresolved if GraphQL is unavailable', async () => {
    graphReplies = [new Error('GraphQL disabled')];
    restReplies = {
      'repos/owner/repo/pulls/7/comments': [
        { id: 1, user: null, body: 'inline', created_at: '2026-10-15T10:00:00Z' },
      ],
    };
    expect(await fetchPRReviewComments(root, 'owner', 'repo', 7)).toMatchObject([
      { id: '1', isResolved: false },
    ]);
  });
});
