export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function write(level: string, event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
}

export const jsonLogger: Logger = {
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
