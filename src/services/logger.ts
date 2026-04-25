import pino, { type Logger } from "pino";

export type { Logger };

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return pino({
    level: opts.level ?? "info",
    transport: opts.pretty
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
            singleLine: true,
          },
        }
      : undefined,
  });
}

/** No-op logger for tests / call sites that don't care about logs. */
export const silentLogger: Logger = pino({ level: "silent" });
