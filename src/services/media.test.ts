import { expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

it('shares icon requests, bounds concurrency and skips abandoned queued previews', async () => {
  const { acquireMedia } = await import('./media');
  const pending: (() => void)[] = [];
  invoke.mockImplementation(() => new Promise(resolve => pending.push(() => resolve([1, 2, 3]))));
  const first = acquireMedia('one', 'clip'), second = acquireMedia('two', 'clip'), third = acquireMedia('three', 'clip');
  const abandoned = acquireMedia('abandoned', 'clip');
  const canceled = abandoned.promise.catch(() => null); abandoned.release();
  const visible = acquireMedia('visible', 'clip');
  expect(invoke).toHaveBeenCalledTimes(3);
  pending[0](); await first.promise; await Promise.resolve();
  expect(await canceled).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(4);
  expect(invoke.mock.calls.map(call => call[1].id)).toEqual(['one', 'two', 'three', 'visible']);
  pending[1](); pending[2](); pending[3]();
  await Promise.all([second.promise, third.promise, visible.promise]);
  first.release(); second.release(); third.release(); visible.release();
  invoke.mockResolvedValue([1, 2, 3]);
  const icon = acquireMedia('editor', 'icon'), repeated = acquireMedia('editor', 'icon');
  expect(await icon.promise).toBe(await repeated.promise);
  expect(invoke).toHaveBeenCalledTimes(5);
  icon.release(); repeated.release();
});
