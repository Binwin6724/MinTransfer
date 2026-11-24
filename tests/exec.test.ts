import { describe, expect, it } from 'vitest';
import { CancelledError, run } from '../electron/exec';

const unix = process.platform !== 'win32';
const big = 'get\t/DCIM/100APPLE/IMG_0001.HEIC\t/tmp/x\n'.repeat(200000); // ~8 MB, more than a pipe holds

describe.skipIf(!unix)('running helper tools', () => {
  it('survives a tool that exits before reading its input (EPIPE)', async () => {
    const r = await run('/bin/sh', ['-c', 'exit 3'], { input: big });
    expect(r.code).toBe(3);
  });

  it('cancels a tool that is still being fed input', async () => {
    const ctrl = new AbortController();
    const p = run('/bin/sh', ['-c', 'sleep 5'], { input: big, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 100);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    // Give the failed write time to surface; an unhandled EPIPE would fail the test run.
    await new Promise((r) => setTimeout(r, 300));
  });
});
