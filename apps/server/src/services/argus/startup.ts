import type { ProjectRef } from '../../types/settings.js';
import type { ArgusService } from './types.js';
import { migrateArgusControlFiles } from './project-lifecycle.js';
import type { FeatureLoader } from '../feature-loader.js';
import { ArgusOrchestrator } from './orchestrator.js';
import type { DeveloperExecutor } from './types.js';

export async function discoverAndResumeArgusProjects(
  projects: ProjectRef[],
  service: ArgusService,
  model: string,
  featureLoader?: FeatureLoader,
  executor?: DeveloperExecutor,
  milestoneD?: { reconcile(projectPath: string): Promise<void> }
): Promise<number> {
  let resumed = 0;
  for (const project of projects) {
    if (!(await migrateArgusControlFiles(project.path))) continue;
    await service.createOrResolveProject({
      projectId: project.id,
      projectPath: project.path,
      model,
    });
    await service.resumeProject(project.path);
    if (featureLoader) {
      const task = await new ArgusOrchestrator(service, featureLoader).reconcileProject(
        project.path
      );
      if (task?.executor === 'jules' && executor) {
        if (task.julesSessionId) await executor.reconcile(task, project.path);
        else await executor.dispatch(task, project.path);
      }
      if (task?.prNumber && milestoneD) await milestoneD.reconcile(project.path);
    }
    resumed += 1;
  }
  return resumed;
}
