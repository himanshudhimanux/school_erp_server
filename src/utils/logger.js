import pino from 'pino';

const nodeEnv = process.env.NODE_ENV || 'development';
const level = process.env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info');

export const logger = pino({
  level,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.refreshToken', '*.token'],
    censor: '[REDACTED]',
  },
  ...(nodeEnv === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } } }
    : {}),
});
