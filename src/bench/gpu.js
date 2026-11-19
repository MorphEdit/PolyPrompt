// GPU load at the start of a benchmark run (best effort, nvidia-smi only):
// B's time depends on the GPU being free for the translator.

export const GPU_QUERY = ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'];
export const GPU_APPS_QUERY = ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'];

const num = (s) => (s && /^\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : null);
const rows = (csv) => csv.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(',').map((s) => s.trim()));

// exec(file, argv) resolves stdout or null. Resolves
// { utilizationPct, memoryUsedMiB, processes: [{ pid, name, memoryMiB }] }
// for the first GPU, or null when nvidia-smi is not available.
export async function gpuLoad(exec) {
  const gpu = await exec('nvidia-smi', GPU_QUERY);
  if (!gpu) return null;
  const [util, mem] = rows(gpu)[0] ?? [];
  const apps = (await exec('nvidia-smi', GPU_APPS_QUERY)) ?? '';
  const processes = rows(apps).map(([pid, name, used]) => ({ pid: num(pid), name: name ?? null, memoryMiB: num(used) }));
  return { utilizationPct: num(util), memoryUsedMiB: num(mem), processes };
}

// One line for REPORT.md's setup.
export function gpuLoadText(load) {
  if (!load) return 'n/a (nvidia-smi not available)';
  const v = (x, unit) => (x === null ? 'n/a' : `${x}${unit}`);
  const procs = load.processes.length
    ? load.processes.map((p) => `${p.name ?? '?'} (pid ${p.pid ?? '?'}, ${v(p.memoryMiB, ' MiB')})`).join(', ')
    : 'none';
  return `utilisation ${v(load.utilizationPct, '%')}, memory used ${v(load.memoryUsedMiB, ' MiB')}; other GPU processes: ${procs}`;
}
