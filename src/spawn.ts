import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface WorkerProcess {
  child: ChildProcess;
  pid: number;
  lines: string[];
  /** Resolve with the first stdout line matching re (or reject after timeoutMs). */
  waitFor(re: RegExp, timeoutMs?: number): Promise<string>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Start src/cli/worker.ts as a separate OS process. Used by the demo and the crash tests. */
export function spawnWorker(env: Record<string, string>, onLine?: (l: string) => void): WorkerProcess {
  const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", join(ROOT, "src/cli/worker.ts")], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const waiters: { re: RegExp; resolve: (l: string) => void }[] = [];
  let buf = "";
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      onLine?.(line);
      for (const w of waiters.splice(0)) (w.re.test(line) ? w.resolve(line) : waiters.push(w));
    }
  });
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => {
      if (code && stderr) process.stderr.write(`worker ${child.pid} stderr:\n${stderr}\n`);
      resolve({ code, signal });
    }),
  );
  return {
    child,
    pid: child.pid!,
    lines,
    exited,
    waitFor(re, timeoutMs = 15000) {
      const hit = lines.find((l) => re.test(l));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${re}; stdout so far:\n${lines.join("\n")}\nstderr:\n${stderr}`)), timeoutMs);
        waiters.push({ re, resolve: (l) => { clearTimeout(t); resolve(l); } });
        exited.then(() => setTimeout(() => reject(new Error(`worker exited before ${re}; stdout:\n${lines.join("\n")}\nstderr:\n${stderr}`)), 50));
      });
    },
  };
}
