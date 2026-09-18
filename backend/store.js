/* Загруженные носки. Метаданные — в json рядом с файлами, чтобы пережить рестарт. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const UPLOAD_DIR = path.join(HERE, 'uploads');
export const VIDEO_DIR = path.join(UPLOAD_DIR, 'video');
export const THUMB_DIR = path.join(UPLOAD_DIR, 'thumb');
export const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatar');
const META = path.join(UPLOAD_DIR, 'socks.json');

for (const dir of [UPLOAD_DIR, VIDEO_DIR, THUMB_DIR, AVATAR_DIR]) fs.mkdirSync(dir, { recursive: true });

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(META, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let items = read();

function flush() {
  fs.writeFileSync(META, JSON.stringify(items, null, 2));
}

export function all() {
  return items;
}

export function byId(id) {
  return items.find((s) => s.id === id);
}

export function add(sock) {
  items.unshift(sock);
  flush();
  return sock;
}

export function update(id, patch) {
  const sock = byId(id);
  if (!sock) return null;
  Object.assign(sock, patch);
  flush();
  return sock;
}

/** Удаляет запись вместе с файлами ролика и превью. */
export function remove(id) {
  const sock = byId(id);
  if (!sock) return false;

  for (const file of [sock.videoFile, sock.thumbFile]) {
    if (!file) continue;
    try { fs.unlinkSync(file); } catch { /* уже нет — и ладно */ }
  }

  items = items.filter((s) => s.id !== id);
  flush();
  return true;
}

/** Сколько дней назад залили — лента сортирует по этому полю. */
export function ageInDays(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}
