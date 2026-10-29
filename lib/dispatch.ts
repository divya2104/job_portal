import { spawn } from "node:child_process";

/**
 * Start the worker for a queued run.
 * Deployed (GH_DISPATCH_TOKEN set): trigger the GitHub Actions `pipeline` workflow with this run id.
 * Local dev: spawn `worker/run.ts --run <id>` in the background.
 */
export async function dispatchRun(runId: string) {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (token) {
    const res = await fetch(`https://api.github.com/repos/${process.env.GH_REPO}/actions/workflows/pipeline.yml/dispatches`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      body: JSON.stringify({ ref: process.env.GH_REF ?? "main", inputs: { run_id: runId } }),
    });
    if (!res.ok) throw new Error(`Couldn't start the run on GitHub Actions (HTTP ${res.status}).`);
    return;
  }
  if (process.env.VERCEL) throw new Error("Run dispatch isn't configured (set GH_DISPATCH_TOKEN and GH_REPO).");
  spawn(process.execPath, ["--env-file-if-exists=.env.local", "worker/run.ts", "--run", runId], {
    cwd: process.cwd(), detached: true, stdio: "ignore",
  }).unref();
}
