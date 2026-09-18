/* Профили. Ни паролей, ни регистрации: у гостя есть токен в localStorage,
   по нему и находится запись. Метаданные — в json рядом с аватарками. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AVATAR_DIR, UPLOAD_DIR } from './store.js';

const META = path.join(UPLOAD_DIR, 'profiles.json');

export const NICK_MAX = 24;
export const BIO_MAX = 160;

const NICKS = [
  'Левый гость', 'Правый_41', 'Анонимный хлопок', 'Гость из барабана',
  'Носок без опознавательных знаков', 'Сушится инкогнито',
];

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

/** Токен наружу не отдаём никому, кроме самого владельца. */
export function publicProfile(p) {
  return {
    id: p.id,
    nick: p.nick,
    bio: p.bio,
    pal: p.pal,
    avatar: p.avatarFile ? `/uploads/avatar/${path.basename(p.avatarFile)}?v=${p.avatarAt ?? 0}` : null,
    createdAt: p.createdAt,
  };
}

export const byId = (id) => items.find((p) => p.id === id);
export const byToken = (token) => (token ? items.find((p) => p.token === token) : undefined);

/** Заводит нового гостя. Токен возвращается один раз — фронт его запоминает. */
export function create() {
  const profile = {
    id: 'u' + crypto.randomBytes(6).toString('hex'),
    token: crypto.randomBytes(24).toString('hex'),
    nick: NICKS[Math.floor(Math.random() * NICKS.length)],
    bio: '',
    pal: Math.floor(Math.random() * 10),
    avatarFile: null,
    avatarAt: 0,
    createdAt: new Date().toISOString(),
  };

  items.push(profile);
  flush();
  return profile;
}

export function update(id, patch) {
  const profile = byId(id);
  if (!profile) return null;
  Object.assign(profile, patch);
  flush();
  return profile;
}

/** Ставит новый файл аватарки и убирает предыдущий. */
export function setAvatar(id, file) {
  const profile = byId(id);
  if (!profile) return null;
  if (profile.avatarFile && profile.avatarFile !== file) dropFile(profile.avatarFile);
  return update(id, { avatarFile: file, avatarAt: Date.now() });
}

export function clearAvatar(id) {
  const profile = byId(id);
  if (!profile) return null;
  if (profile.avatarFile) dropFile(profile.avatarFile);
  return update(id, { avatarFile: null, avatarAt: Date.now() });
}

function dropFile(file) {
  try { fs.unlinkSync(file); } catch { /* уже нет — и ладно */ }
}

export { AVATAR_DIR };
