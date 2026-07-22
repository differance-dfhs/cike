import { execFile } from 'node:child_process';

export class ProcessExecutionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ProcessExecutionError';
    this.code = options.code;
    this.timedOut = Boolean(options.timedOut);
    this.publicMessage = options.publicMessage || message;
  }
}
export function execFileText(file, args, options = {}) {
  const timeout = options.timeout ?? 10_000;
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
  const env = { ...process.env, ...(options.env || {}) };

  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env,
        encoding: 'utf8',
        timeout,
        killSignal: 'SIGTERM',
        maxBuffer,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new ProcessExecutionError(options.errorMessage || `${file} 执行失败`, {
              code: error.code,
              timedOut: error.killed || error.signal === 'SIGTERM',
              publicMessage: options.publicMessage,
            }),
          );
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

export async function execFileJson(file, args, options = {}) {
  const { stdout } = await execFileText(file, args, options);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new ProcessExecutionError(options.parseErrorMessage || `${file} 返回了无法解析的数据`, {
      publicMessage: options.publicMessage,
    });
  }
}
