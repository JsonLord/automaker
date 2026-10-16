import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getEventHistoryDir,
  getEventHistoryIndexPath,
  getEventPath,
  initAllowedPaths,
} from '@automaker/platform';
import { DEFAULT_EVENT_HISTORY_INDEX, type StoredEventSummary } from '@automaker/types';
import * as secureFs from '../../../src/lib/secure-fs.js';
import {
  EventHistoryService,
  getEventHistoryService,
} from '../../../src/services/event-history-service.js';

vi.mock('@automaker/utils', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

describe('EventHistoryService persistent history', () => {
  let root: string;
  let project: string;
  let service: EventHistoryService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'automaker-event-history-'));
    project = path.join(root, 'project-a');
    vi.stubEnv('ALLOWED_ROOT_DIRECTORY', root);
    vi.stubEnv('DATA_DIR', root);
    initAllowedPaths();
    service = new EventHistoryService();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedIndex(events: StoredEventSummary[]): Promise<void> {
    await fs.mkdir(getEventHistoryDir(project), { recursive: true });
    await fs.writeFile(
      getEventHistoryIndexPath(project),
      JSON.stringify({ version: 1, events }),
      'utf-8'
    );
  }

  it('returns empty history and absent-event results before the first write', async () => {
    expect(await service.getEvents(project)).toEqual([]);
    expect(await service.getEventCount(project)).toBe(0);
    expect(await service.getEvent(project, 'missing')).toBeNull();
    expect(await service.deleteEvent(project, 'missing')).toBe(false);
  });

  it('round-trips the complete event across service instances without putting metadata in the index', async () => {
    const event = await service.storeEvent({
      projectPath: project,
      trigger: 'feature_error',
      featureId: 'feature-7',
      featureName: 'Repair authentication',
      error: 'The worker exited',
      errorType: 'execution',
      passes: false,
      metadata: { attempt: 2, worker: { id: 'isolated-1' } },
    });
    expect(event.id).toMatch(/^evt-\d+-[a-f0-9-]{8}$/);
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
    expect(event.projectName).toBe('project-a');

    const restarted = new EventHistoryService();
    expect(await restarted.getEvent(project, event.id)).toEqual(event);
    expect(await restarted.getEvents(project)).toEqual([
      {
        id: event.id,
        trigger: 'feature_error',
        timestamp: event.timestamp,
        featureId: 'feature-7',
        featureName: 'Repair authentication',
      },
    ]);
    const persisted = JSON.parse(await fs.readFile(getEventHistoryIndexPath(project), 'utf-8'));
    expect(persisted.version).toBe(1);
    expect(persisted.events[0]).not.toHaveProperty('metadata');
    expect(await fs.readdir(getEventHistoryDir(project))).toEqual(
      expect.arrayContaining(['index.json', `${event.id}.json`])
    );
    expect(
      (await fs.readdir(getEventHistoryDir(project))).some((file) => file.includes('.tmp.'))
    ).toBe(false);
  });

  it('never leaks an event summary into a different project with no index', async () => {
    const event = await service.storeEvent({ projectPath: project, trigger: 'feature_created' });
    const otherProject = path.join(root, 'project-b');
    expect(await service.getEvents(otherProject)).toEqual([]);
    const other = await service.storeEvent({
      projectPath: otherProject,
      trigger: 'feature_success',
    });
    expect((await service.getEvents(project)).map((item) => item.id)).toEqual([event.id]);
    expect((await service.getEvents(otherProject)).map((item) => item.id)).toEqual([other.id]);
    expect(DEFAULT_EVENT_HISTORY_INDEX).toEqual({ version: 1, events: [] });
  });

  it('combines trigger, feature and inclusive time filters before newest-first pagination', async () => {
    await seedIndex([
      { id: 'old', trigger: 'feature_error', featureId: 'f1', timestamp: '2026-01-01T00:00:00Z' },
      { id: 'new', trigger: 'feature_error', featureId: 'f1', timestamp: '2026-01-03T00:00:00Z' },
      {
        id: 'middle',
        trigger: 'feature_error',
        featureId: 'f1',
        timestamp: '2026-01-02T00:00:00Z',
      },
      {
        id: 'other-feature',
        trigger: 'feature_error',
        featureId: 'f2',
        timestamp: '2026-01-02T12:00:00Z',
      },
      {
        id: 'success',
        trigger: 'feature_success',
        featureId: 'f1',
        timestamp: '2026-01-02T12:00:00Z',
      },
    ]);
    const filter = {
      trigger: 'feature_error' as const,
      featureId: 'f1',
      since: '2026-01-01T00:00:00Z',
      until: '2026-01-03T00:00:00Z',
      offset: 1,
      limit: 1,
    };
    expect((await service.getEvents(project, filter)).map((event) => event.id)).toEqual(['middle']);
    expect(await service.getEventCount(project, filter)).toBe(3);
    expect((await service.getEvents(project)).map((event) => event.id)).toEqual([
      'new',
      'other-feature',
      'success',
      'middle',
      'old',
    ]);
  });

  it('deletes both persisted representations and makes repeated deletion idempotent', async () => {
    const event = await service.storeEvent({ projectPath: project, trigger: 'feature_created' });
    expect(await service.deleteEvent(project, event.id)).toBe(true);
    expect(await new EventHistoryService().getEvent(project, event.id)).toBeNull();
    expect(await service.getEvents(project)).toEqual([]);
    await expect(fs.stat(getEventPath(project, event.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await service.deleteEvent(project, event.id)).toBe(false);
  });

  it('removes an indexed event even if its full event file was already lost', async () => {
    const event = await service.storeEvent({ projectPath: project, trigger: 'feature_created' });
    await fs.unlink(getEventPath(project, event.id));
    expect(await service.deleteEvent(project, event.id)).toBe(true);
    expect(await service.getEventCount(project)).toBe(0);
  });

  it('clears every indexed event while preserving unrelated files and resets the persisted index', async () => {
    const first = await service.storeEvent({ projectPath: project, trigger: 'feature_created' });
    const second = await service.storeEvent({ projectPath: project, trigger: 'feature_success' });
    const unrelated = path.join(getEventHistoryDir(project), 'diagnostics.txt');
    await fs.writeFile(unrelated, 'preserve');
    // Missing full records are recoverable during cleanup.
    await fs.unlink(getEventPath(project, first.id));
    expect(await service.clearEvents(project)).toBe(2);
    expect(await new EventHistoryService().getEvents(project)).toEqual([]);
    expect(await service.getEvent(project, second.id)).toBeNull();
    expect(await fs.readFile(unrelated, 'utf-8')).toBe('preserve');
    expect(JSON.parse(await fs.readFile(getEventHistoryIndexPath(project), 'utf-8'))).toEqual({
      version: 1,
      events: [],
    });
    expect(await service.clearEvents(project)).toBe(0);
  });

  it('tolerates malformed persisted JSON on reads without silently rewriting the damaged files', async () => {
    await fs.mkdir(getEventHistoryDir(project), { recursive: true });
    await fs.writeFile(getEventHistoryIndexPath(project), '{broken');
    await fs.writeFile(getEventPath(project, 'damaged'), '{broken-event');
    expect(await service.getEvents(project)).toEqual([]);
    expect(await service.getEvent(project, 'damaged')).toBeNull();
    expect(await fs.readFile(getEventHistoryIndexPath(project), 'utf-8')).toBe('{broken');
    expect(await fs.readFile(getEventPath(project, 'damaged'), 'utf-8')).toBe('{broken-event');
  });

  it('cleans temporary output after a failed rename and does not create an index', async () => {
    vi.spyOn(secureFs, 'rename').mockRejectedValueOnce(new Error('rename interrupted'));
    await expect(
      service.storeEvent({ projectPath: project, trigger: 'feature_created' })
    ).rejects.toThrow('rename interrupted');
    expect(await fs.readdir(getEventHistoryDir(project))).toEqual([]);
    expect(await service.getEvents(project)).toEqual([]);
    const recovered = await service.storeEvent({
      projectPath: project,
      trigger: 'feature_success',
    });
    expect((await service.getEvents(project)).map((event) => event.id)).toEqual([recovered.id]);
  });

  it('prunes the oldest indexed event and its file after retaining the newest thousand records', async () => {
    const summaries = Array.from({ length: 1000 }, (_, index) => ({
      id: `existing-${index}`,
      trigger: 'feature_created' as const,
      timestamp: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(),
    }));
    await seedIndex(summaries);
    const removedPath = getEventPath(project, 'existing-999');
    await fs.writeFile(removedPath, JSON.stringify({ id: 'existing-999' }));
    const newest = await service.storeEvent({ projectPath: project, trigger: 'feature_success' });
    const history = await new EventHistoryService().getEvents(project);
    expect(history).toHaveLength(1000);
    expect(history[0].id).toBe(newest.id);
    expect(history.some((event) => event.id === 'existing-999')).toBe(false);
    expect(history.some((event) => event.id === 'existing-998')).toBe(true);
    await expect(fs.stat(removedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves every accepted event during concurrent writes from independent service instances', async () => {
    // An existing index also exercises the read/modify/write race, rather than only default creation.
    await seedIndex([]);
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const writes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        new EventHistoryService().storeEvent({
          projectPath: project,
          trigger: 'feature_created',
          featureId: `feature-${index}`,
        })
      )
    );
    expect(writes.filter((write) => write.status === 'rejected')).toEqual([]);
    const stored = writes.map((write) => {
      if (write.status === 'rejected') throw write.reason;
      return write.value;
    });
    const history = await new EventHistoryService().getEvents(project);
    expect(history).toHaveLength(stored.length);
    expect(new Set(history.map((event) => event.id))).toEqual(
      new Set(stored.map((event) => event.id))
    );
    for (const event of stored) {
      expect(await service.getEvent(project, event.id)).toEqual(event);
    }
  });

  it('does not restore deleted summaries when stores and deletes race across service instances', async () => {
    const first = await service.storeEvent({ projectPath: project, trigger: 'feature_created' });
    const second = await service.storeEvent({ projectPath: project, trigger: 'feature_success' });
    const [, added] = await Promise.all([
      new EventHistoryService().deleteEvent(project, first.id),
      new EventHistoryService().storeEvent({ projectPath: project, trigger: 'feature_error' }),
      new EventHistoryService().deleteEvent(project, second.id),
    ]);
    expect((await new EventHistoryService().getEvents(project)).map((event) => event.id)).toEqual([
      added.id,
    ]);
    expect(await service.getEvent(project, first.id)).toBeNull();
    expect(await service.getEvent(project, second.id)).toBeNull();
    expect(await service.getEvent(project, added.id)).toEqual(added);
  });

  it('rejects storage outside the configured filesystem boundary', async () => {
    await expect(
      service.storeEvent({
        projectPath: `${root}-outside`,
        trigger: 'feature_created',
      })
    ).rejects.toMatchObject({ name: 'PathNotAllowedError' });
  });

  it('shares the application singleton without conflating explicitly constructed services', () => {
    expect(getEventHistoryService()).toBe(getEventHistoryService());
    expect(getEventHistoryService()).not.toBe(service);
  });
});
