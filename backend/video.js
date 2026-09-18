/* Всё, что связано с ffmpeg: длительность ролика и кадр для превью. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Длительность в секундах. 0 — значит файл не похож на видео. */
export async function probeDuration(file) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    const sec = Number.parseFloat(stdout.trim());
    return Number.isFinite(sec) && sec > 0 ? sec : 0;
  } catch {
    return 0;
  }
}

/**
 * Случайная секунда для превью. Начало и конец не берём: там часто
 * чёрный кадр или титры.
 */
export function randomTimestamp(duration) {
  if (duration <= 2) return duration / 2;
  const from = duration * 0.1;
  const to = duration * 0.85;
  return +(from + Math.random() * (to - from)).toFixed(2);
}

/** Вырезает один кадр в jpeg шириной 640px. */
export async function grabFrame(file, at, out) {
  await run('ffmpeg', [
    '-y',
    '-ss', String(at),
    '-i', file,
    '-frames:v', '1',
    '-vf', 'scale=640:-2',
    '-q:v', '3',
    out,
  ]);
  return out;
}

/** Есть ли вообще ffmpeg в системе — проверяем один раз при старте. */
export async function ffmpegReady() {
  try {
    await Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]);
    return true;
  } catch {
    return false;
  }
}
