import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

// Code-native app mark, matching public/clip.svg. No external image or font needed.
const size = 64;
const rgba = Buffer.alloc(size * size * 4);
function roundedRect(x, y, width, height, radius, color) {
  for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) {
    const nx = Math.max(x + radius, Math.min(x + width - radius - 1, px));
    const ny = Math.max(y + radius, Math.min(y + height - radius - 1, py));
    if ((px - nx) ** 2 + (py - ny) ** 2 > radius ** 2) continue;
    const offset = (py * size + px) * 4;
    color.forEach((channel, index) => { rgba[offset + index] = channel; });
  }
}
roundedRect(8, 9, 35, 43, 9, [148, 221, 247, 255]);
roundedRect(21, 17, 35, 43, 9, [0, 169, 230, 255]);
roundedRect(30, 30, 18, 3, 1, [255, 255, 255, 255]);
roundedRect(30, 38, 18, 3, 1, [255, 255, 255, 255]);
roundedRect(30, 46, 11, 3, 1, [255, 255, 255, 255]);
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const trailer = Buffer.alloc(4); trailer.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, trailer]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const pixels = Buffer.concat(Array.from({ length: size }, (_, row) => Buffer.concat([Buffer.from([0]), rgba.subarray(row * size * 4, (row + 1) * size * 4)])));
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const icoHeader = Buffer.alloc(22); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4); icoHeader[6] = size; icoHeader[7] = size;
icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12); icoHeader.writeUInt32LE(png.length, 14); icoHeader.writeUInt32LE(22, 18);
await mkdir('src-tauri/icons', { recursive: true });
await writeFile('src-tauri/icons/icon.png', png);
await writeFile('src-tauri/icons/icon.ico', Buffer.concat([icoHeader, png]));
