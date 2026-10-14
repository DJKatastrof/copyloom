// Suggested name for Save as: a name the user gave the clip, otherwise program and capture time,
// e.g. "Microsoft Teams 2026-10-07 103512.png". Native code makes the result safe for Windows.
export function imageFileName(image: { createdAt: number; source?: string | null; customTitle?: string | null }): string {
  const custom = image.customTitle?.trim();
  if (custom) return custom + '.png';
  const time = new Date(image.createdAt), pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}${pad(time.getMinutes())}${pad(time.getSeconds())}`;
  return `${image.source?.trim() || 'Copyloom'} ${stamp}.png`;
}
