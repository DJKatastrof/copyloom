# Changelog

## 0.1.40 – 2026-11-10

- **Library:** the Quick panel and Add buttons are removed from the top bar. Sorting and expand/collapse all days now sit directly above the dates. The quick panel and its shortcut remain available.
- **Image editor:** move and resize the selected pixelation while Pixelate is active, without creating another effect. Pixelation stays visible while drawing, moving and resizing instead of temporarily becoming an outline. Undo and redo still work.
- Resize handles use standard directional cursors: diagonal at corners and horizontal or vertical at edges. Movable shapes show a move cursor, and panning shows a hand. Handles also work while the shape's drawing tool remains active.
- **History:** choose *Custom* retention, enter 1 to 36,500 whole days and save. Shorter retention always asks for confirmation, even when no clips will be deleted now, for both presets and custom days. The dialog shows the selected period, immediate deletion count and protected clips. Clicking outside leaves it open; Cancel or Escape keeps the history and setting. Longer retention and Forever apply directly. Favorites remain protected.
- **Confirmations:** clearer separation from the background, especially in dark mode, with a lighter dialog surface, larger readable body text, deeper shadow and stronger background dimming. This also applies to the editor's unsaved-changes dialog.
- **Updates:** Copyloom looks for a new version on GitHub shortly after it starts and then once a day. When one is out, the library says so, and one click installs it and starts the new version. Nothing installs without that click.
- Settings → General → *Updates*: turn the daily check off, or check now.
- The installer is verified against Copyloom's own signing key before it runs.
- Versions up to 0.1.39 cannot update themselves; install 0.1.40 once by hand.

## 0.1.39 – 2026-10-20

- **Delete a day:** right-click a day heading in the library and choose *Delete day*. It removes the clips under that heading in the current view, favorites included, after a confirmation that says how many.
- **Clean up by date:** Settings → History → *Delete clips created before* removes everything older than the chosen date. Favorites are kept, and so are clips in categories when *Keep clips in categories* is on.
- Day headings and row times now switch language at once, roll over at midnight, and keep their “13 min” times current.

## 0.1.38 – 2026-10-14

First public source release.

- **Quick panel:** a compact list that opens at the mouse pointer, the text cursor, the centre of the screen, or where it was last.
  - Search as you type, and filter by favorites or category.
  - Space previews a clip, and a trash button removes one.
  - It can be moved and resized; size and position are remembered.
  - A click or a double-click pastes, as you choose in Settings.
- **Library:** clips grouped by day, with the selected clip shown in full. Favorites, categories, renaming, text editing, and copying several texts together.
- **Images:**
  - Capture an area of the screen with a key of your choice.
  - An editor with arrows, rectangles, text, highlighting, numbered steps, pixelation, redaction and cropping.
  - Text recognition with Windows' built-in engine.
- **History:**
  - Encrypted storage (SQLCipher, key protected with the Windows account) in a folder you choose.
  - Retention from a day to forever, and app exclusions.
  - Local backups, and password-protected export and restore.
- **Win+V:** can open the quick panel instead of Windows' clipboard history, and can be given back.
- **Interface:** English and Swedish, light and dark.
