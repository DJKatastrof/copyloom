# Changelog

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
