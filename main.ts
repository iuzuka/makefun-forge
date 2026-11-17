import { appendFileSync } from 'node:fs';
import { createApp } from './app.ts';

const CRASH_LOG = '/tmp/forge-crash.log';

function logCrash(error: Error): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${error.name}: ${error.message}\n${error.stack}\n`;
  appendFileSync(CRASH_LOG, line);
}

process.on('uncaughtException', (error: Error) => {
  logCrash(error);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logCrash(error);
  process.exit(1);
});

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function registerWithEnv(envUrl: string, port: number, maxRetries = 10): Promise<void> {
  const registerUrl = `${envUrl}/register`;
  let delay = 100;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(registerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });

      if (response.status === 409) {
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }

      if (response.ok) {
        return;
      }

      if (response.status >= 500) {
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }

      const text = await response.text();
      throw new Error(`Registration failed: HTTP ${response.status} ${text}`);
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      if (error instanceof Error && error.message.includes('Registration failed')) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  }
  throw new Error('Registration failed after max retries');
}

async function waitForDone(envUrl: string): Promise<void> {
  const doneUrl = `${envUrl}/done`;
  let delay = 100;

  while (true) {
    try {
      const response = await fetch(doneUrl);
      if (!response.ok) {
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }

      const text = await response.text();
      let done = false;
      try {
        const json = JSON.parse(text);
        done = json.done === true;
      } catch {
        done = false;
      }

      if (done) {
        return;
      }

      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    } catch {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  }
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl || envUrl.trim() === '') {
    console.error('MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }

  const portEnv = process.env.MAKEFUN_ENTRY_PORT;
  const fixedPort = portEnv ? parseInt(portEnv, 10) : 0;
  const listenPort = Number.isFinite(fixedPort) && fixedPort > 0 ? fixedPort : 0;

  const app = createApp();

  await new Promise<void>((resolve, reject) => {
    app.listen(listenPort, () => {
      const address = app.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        registerWithEnv(envUrl, port)
          .then(() => waitForDone(envUrl))
          .then(() => {
            app.close(() => {
              resolve();
            });
          })
          .catch(reject);
      } else {
        reject(new Error('Failed to determine server port'));
      }
    });

    app.on('error', reject);
  });

  process.exit(0);
}

main().catch((error: Error) => {
  logCrash(error);
  process.exit(1);
});