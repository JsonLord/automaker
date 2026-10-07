import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getNotificationService } from '../../../src/services/notification-service.js';

describe('NotificationService concurrency', () => {
  let tempProjectDir: string;

  beforeEach(async () => {
    tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'automaker-notif-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  it('should handle rapid concurrent notification creation without race condition errors', async () => {
    const service = getNotificationService();

    const tasks = Array.from({ length: 20 }, (_, i) =>
      service.createNotification({
        projectPath: tempProjectDir,
        type: 'feature_status_changed',
        title: `Test Notification ${i}`,
        message: `Message ${i}`,
      })
    );

    const results = await Promise.all(tasks);

    expect(results).toHaveLength(20);

    const all = await service.getNotifications(tempProjectDir);
    expect(all).toHaveLength(20);
  });
});
