export type SaveResult = { id: string; copied: boolean; error?: string | null; elapsedMs?: number };
export type SavedImage = { id: string; signature: string; copied: boolean };
export type SaveState = { saved: SavedImage | null; busy: boolean };
export function needsSave(state: SaveState, signature: string): boolean { return state.saved?.signature !== signature; }
export async function saveOrCopy(state: SaveState, signature: string, save: () => Promise<SaveResult>, copy: (id: string) => Promise<unknown>): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  try {
    if (needsSave(state, signature)) {
      const result = await save(); state.saved = { id: result.id, signature, copied: result.copied };
      if (!result.copied) throw new Error(result.error || 'The image is saved, but the clipboard is busy. Try copying again.');
    } else { await copy(state.saved!.id); state.saved!.copied = true; }
  } finally { state.busy = false; }
}
