import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

interface Lease { pid: number; host: string; token: string }
export class BusyError extends Error { constructor() { super('Another plugin process owns this native operation. Reconnect or wait for its extraction to finish.'); } }
function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function occupied(error: unknown) { return ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''); }

/** Only removes the observed token and an empty directory, never a replacement lease. */
async function retire(path: string, owner: string): Promise<void> {
  try { await unlink(join(path, owner)); } catch (error) { if (!missing(error)) throw error; }
  try { await rmdir(path); } catch (error) { if (!missing(error) && !occupied(error)) throw error; }
}

/** Publish complete leases atomically. Dead owners recover without TTLs or stealing from live PIDs. */
export async function acquireLock(root: string, key: string): Promise<() => Promise<void>> {
  const base = join(root, 'locks');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const path = join(base, `${createHash('sha256').update(key).digest('hex')}.lock`);
  const lease: Lease = { pid: process.pid, host: hostname(), token: randomUUID() };
  const owner = `owner-${lease.token}.json`;
  const staging = `${path}.${lease.token}.staging`;
  await mkdir(staging, { mode: 0o700 });
  try {
    const handle = await open(join(staging, owner), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(lease)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(staging, path); }
    catch (error) {
      if (!occupied(error)) throw error;
      let names: string[];
      try { names = await readdir(path); } catch { throw new BusyError(); }
      if (names.length === 0) {
        try { await rmdir(path); } catch (error) { if (!missing(error) && !occupied(error)) throw error; }
      } else {
        const previousOwner = names[0]!;
        if (names.length !== 1 || !/^owner-[0-9a-f-]{36}\.json$/i.test(previousOwner)) throw new BusyError();
        let previous: Lease;
        try { previous = JSON.parse(await readFile(join(path, previousOwner), 'utf8')) as Lease; }
        catch { throw new BusyError(); }
        if (previous.host !== hostname() || previousOwner !== `owner-${previous.token}.json`
          || !Number.isInteger(previous.pid) || previous.pid <= 0) throw new BusyError();
        try { process.kill(previous.pid, 0); throw new BusyError(); }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw new BusyError(); }
        await retire(path, previousOwner);
      }
      try { await rename(staging, path); } catch (error) { if (occupied(error) || missing(error)) throw new BusyError(); throw error; }
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
  return async () => { await retire(path, owner); };
}
