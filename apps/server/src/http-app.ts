import express from 'express';
import cookieParser from 'cookie-parser';
import { jsonParserErrorHandler } from './middleware/json-errors.js';
import { requireJsonContentType } from './middleware/require-json-content-type.js';
/** Production transport assembly, shared by the actual startup and integration tests. */
export function createHttpApplication(
  options: {
    beforeParsing?: (app: express.Express) => void;
    routes?: (app: express.Express) => void;
  } = {}
) {
  const app = express();
  options.beforeParsing?.(app);
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.use(jsonParserErrorHandler);
  app.use('/api', requireJsonContentType);
  options.routes?.(app);
  return app;
}
