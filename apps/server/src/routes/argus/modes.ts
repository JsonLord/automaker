import { Router } from 'express';
import { z } from 'zod';
import { ModeError, modeConfigSchema, modeIdSchema } from '../../services/argus/modes/contracts.js';
import type { ArgusModeService } from '../../services/argus/modes/service.js';

/** Mounted after the existing authenticated project-access boundary. */
export function createModeRoutes(service: ArgusModeService) {
  const router = Router();
  const endpoint =
    (fn: (req: import('express').Request, res: import('express').Response) => Promise<unknown>) =>
    async (req: import('express').Request, res: import('express').Response) => {
      try {
        await fn(req, res);
      } catch (error) {
        if (error instanceof z.ZodError)
          return res.status(400).json({ error: 'MODE_INVALID_INPUT' });
        if (error instanceof ModeError) return res.status(error.status).json({ error: error.code });
        const code = error instanceof Error ? error.message : '';
        return res.status(code === 'ARGUS_PERSISTENCE_LOCKED' ? 409 : 503).json({
          error:
            code === 'ARGUS_PERSISTENCE_LOCKED'
              ? 'MODE_BUSY'
              : 'MODE_STORAGE_OR_DEPENDENCY_UNAVAILABLE',
        });
      }
    };
  router.get(
    '/modes',
    endpoint(async (_req, res) => res.json({ modes: service.descriptors }))
  );
  router.get(
    '/mode',
    endpoint(async (_req, res) => res.json(await service.state(res.locals.projectPath)))
  );
  router.put(
    '/mode',
    endpoint(async (req, res) => {
      const { mode, config, expectedRevision } = z
        .object({
          projectId: z.string().optional(),
          projectPath: z.string().optional(),
          mode: modeIdSchema,
          config: modeConfigSchema.optional(),
          expectedRevision: z.number().int().min(0),
        })
        .strict()
        .parse(req.body);
      return res.json(await service.select(res.locals.projectPath, mode, config, expectedRevision));
    })
  );
  router.post(
    '/mode/command',
    endpoint(async (req, res) =>
      res.json(
        await service.command(res.locals.projectPath, z.string().max(40).parse(req.body.command))
      )
    )
  );
  router.post(
    '/mode/plan',
    endpoint(async (req, res) =>
      res
        .status(201)
        .json(
          await service.plan(
            res.locals.projectPath,
            req.body.input,
            z.string().parse(req.body.idempotencyKey)
          )
        )
    )
  );
  router.post(
    '/mode/run',
    endpoint(async (req, res) => {
      const approval =
        req.body.approval === undefined
          ? undefined
          : z
              .object({
                repositoryChanges: z.literal(true),
                sourceSha: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/i),
              })
              .strict()
              .parse(req.body.approval);
      return res.json(
        await service.run(res.locals.projectPath, z.string().parse(req.body.runId), approval)
      );
    })
  );
  router.get(
    '/mode/gate',
    endpoint(async (_req, res) => res.json(await service.gate(res.locals.projectPath)))
  );
  router.get(
    '/mode/runs/:id',
    endpoint(async (req, res) =>
      res.json(await service.get(res.locals.projectPath, req.params.id as string))
    )
  );
  router.get(
    '/mode/runs/:id/artifacts',
    endpoint(async (req, res) =>
      res.json({
        artifacts: (await service.get(res.locals.projectPath, req.params.id as string)).artifacts,
      })
    )
  );
  router.post(
    '/mode/runs/:id/tasks/:taskId/approve',
    endpoint(async (req, res) => {
      z.literal(true).parse(req.body.approved);
      return res.json(
        await service.approveTask(
          res.locals.projectPath,
          req.params.id as string,
          req.params.taskId as string,
          z
            .string()
            .regex(/^(?!0{40}$)[0-9a-f]{40}$/i)
            .parse(req.body.sourceSha)
        )
      );
    })
  );
  return router;
}
