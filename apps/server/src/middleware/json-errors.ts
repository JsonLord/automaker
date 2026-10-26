import type { ErrorRequestHandler } from 'express';
/** Never echo body-parser's body, stack, message, or filesystem details. */
export const jsonParserErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (error?.type === 'entity.parse.failed' && error.status === 400) {
    res.status(400).json({
      success: false,
      error: { code: 'MALFORMED_JSON', message: 'Invalid JSON payload received' },
    });
    return;
  }
  if (error?.type === 'entity.too.large' && error.status === 413) {
    res.status(413).json({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'JSON payload exceeds the request limit' },
    });
    return;
  }
  next(error);
};
