import { expect, it, vi } from 'vitest';
import { needsSave, saveOrCopy } from './save';
import type { SaveState } from './save';
it('retries clipboard without a new clip, then saves new changes', async () => {
  const state: SaveState = { saved: null, busy: false };
  const save = vi.fn().mockResolvedValue({ id: 'saved-1', copied: false, error: 'Upptaget' }), copy = vi.fn().mockResolvedValue(undefined);
  await expect(saveOrCopy(state, 'version-1', save, copy)).rejects.toThrow('Upptaget');
  expect(state.saved?.id).toBe('saved-1'); expect(needsSave(state, 'version-1')).toBe(false);
  await saveOrCopy(state, 'version-1', save, copy); expect(save).toHaveBeenCalledTimes(1); expect(copy).toHaveBeenCalledWith('saved-1');
  await saveOrCopy(state, 'version-1', save, copy); expect(save).toHaveBeenCalledTimes(1);
  save.mockResolvedValue({ id: 'saved-2', copied: true });
  await saveOrCopy(state, 'version-2', save, copy); expect(state.saved?.id).toBe('saved-2'); expect(save).toHaveBeenCalledTimes(2);
});
it('keeps previous saved version when persistence fails and serializes repeated clicks', async () => {
  const state: SaveState = { saved: { id: 'previous', signature: 'old', copied: true }, busy: false };
  const copy = vi.fn(); const save = vi.fn().mockRejectedValue(new Error('Diskfel'));
  await expect(saveOrCopy(state, 'new', save, copy)).rejects.toThrow('Diskfel'); expect(copy).not.toHaveBeenCalled(); expect(state.saved?.signature).toBe('old'); expect(state.busy).toBe(false);
  let finish!: (value: unknown) => void; save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = saveOrCopy(state, 'new', save, copy); await saveOrCopy(state, 'new', save, copy); expect(save).toHaveBeenCalledTimes(2);
  finish({ id: 'next', copied: true }); await pending;
});
