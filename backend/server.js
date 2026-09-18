/**
 * LostSocks API — каталог носков, потерявшихся при стирке.
 *
 * Запуск:  npm start  (или npm run dev — с автоперезапуском)
 * Фронт отдаётся тем же процессом на /
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';

import { CATEGORIES } from './data.js';
import * as profiles from './profiles.js';
import * as store from './store.js';
import { ffmpegReady, grabFrame, probeDuration, randomTimestamp } from './video.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(HERE, '..', 'frontend');
const PORT = Number(process.env.PORT) || 8000;
const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 300;

const AVATAR_MB = Number(process.env.MAX_AVATAR_MB) || 5;

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v', '.avi', '.ogv']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const app = express();
app.use(express.json({ limit: '8kb' }));

// фронт можно открыть и файлом с диска — тогда запросы приходят с другого origin
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Sock-Token, X-Admin-Token');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// токен приходит заголовком; нет токена — значит просто прохожий
app.use((req, res, next) => {
  req.profile = profiles.byToken(req.get('X-Sock-Token')) ?? null;
  next();
});

const SORTERS = {
  new: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  views: (a, b) => b.views - a.views,
  likes: (a, b) => b.likes - a.likes,
  dur: (a, b) => b.dur - a.dur,
};

/* Пароль админа. Не задан в окружении — генерируем разовый и печатаем в консоль,
   иначе загрузка оказалась бы открыта всем. */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(5).toString('hex');
const ADMIN_GENERATED = !process.env.ADMIN_PASSWORD;
const adminTokens = new Set();

/** Ошибка, которую фронт покажет как есть: он читает поле detail. */
class ApiError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

/* ─── каталог ────────────────────────────────────────────────────────── */

/* Лайки и комментарии живут в памяти процесса и рестарт не переживают. */
const LIKES = new Map();
const COMMENTS = new Map();

const likesOf = (id) => LIKES.get(id) ?? 0;

function commentsOf(id) {
  if (!COMMENTS.has(id)) COMMENTS.set(id, []);
  return COMMENTS.get(id);
}

/** Запись из хранилища в том виде, в каком её ждёт фронт.
    Пути к файлам на диске наружу не отдаём — только ссылки. */
function fromUpload(sock) {
  const { videoFile, thumbFile, ...rest } = sock;
  return {
    ...rest,
    age: store.ageInDays(sock.createdAt),
    video: `/uploads/video/${path.basename(videoFile)}`,
    thumb: `/uploads/thumb/${path.basename(thumbFile)}`,
  };
}

const catalog = () => store.all().map(fromUpload);

function mustFind(id) {
  const sock = store.byId(id);
  if (!sock) throw new ApiError(404, 'Носок не найден. Посмотрите под диваном.');
  return fromUpload(sock);
}

const publicSock = (sock) => ({ ...sock, likes: sock.likes + likesOf(sock.id) });

/** Ник и аватарка берутся из профиля, поэтому старые комментарии
    переподписываются сами, когда автор меняет ник. */
function publicComment(comment, meId) {
  const author = comment.authorId ? profiles.byId(comment.authorId) : null;
  return {
    ...comment,
    author: author ? author.nick : comment.author,
    authorPal: author ? author.pal : null,
    authorAvatar: author ? profiles.publicProfile(author).avatar : null,
    mine: Boolean(comment.authorId && comment.authorId === meId),
  };
}

function mustBeMe(req) {
  if (!req.profile) throw new ApiError(401, 'Профиль не найден. Обновите страницу.');
  return req.profile;
}

function matches(sock, cat, q) {
  if (cat !== 'Всё' && !sock.cats.includes(cat)) return false;
  if (!q) return true;
  return [sock.title, ...sock.tags, ...sock.cats].join(' ').toLowerCase().includes(q);
}

function intParam(raw, { min, max, fallback }) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(422, `Ожидалось целое от ${min} до ${max}, пришло «${raw}»`);
  }
  return n;
}

/* ─── приём файлов ───────────────────────────────────────────────────── */

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, store.VIDEO_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext || '.mp4'}`);
    },
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('video/') || VIDEO_EXT.has(ext)) return cb(null, true);
    cb(new ApiError(415, 'Нужен видеофайл: mp4, webm, mov, mkv'));
  },
});

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, store.AVATAR_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${req.profile?.id ?? 'anon'}-${crypto.randomBytes(3).toString('hex')}${IMAGE_EXT.has(ext) ? ext : '.jpg'}`);
    },
  }),
  limits: { fileSize: AVATAR_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('image/') || IMAGE_EXT.has(ext)) return cb(null, true);
    cb(new ApiError(415, 'Нужна картинка: jpg, png, webp или gif'));
  },
});

const dropFile = (file) => {
  if (file?.path) { try { fs.unlinkSync(file.path); } catch { /* уже нет */ } }
};

/** Категории приходят как повторяющиеся поля формы или как одна строка через запятую. */
function parseCats(raw) {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map((c) => c.trim())
    .filter(Boolean);

  const known = list.filter((c) => CATEGORIES.includes(c) && c !== 'Всё');
  const unknown = list.filter((c) => !CATEGORIES.includes(c));
  if (unknown.length) throw new ApiError(422, `Нет такой категории: ${unknown[0]}`);

  return known.length ? [...new Set(known)] : ['Без пары'];
}

/** Теги: массив или строка через запятую. Решётку ставим сами, чтобы вид был один. */
function parseTags(raw) {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\s]+/))
    .map((t) => '#' + String(t).trim().replace(/^#+/, '').replace(/\s+/g, '').toLowerCase())
    .filter((t) => t.length > 1);

  const tooLong = list.find((t) => t.length > 25);
  if (tooLong) throw new ApiError(422, `Тег «${tooLong}» длиннее 24 символов`);

  return [...new Set(list)].slice(0, 8);
}

const api = express.Router();

api.get('/categories', (req, res) => {
  res.json(CATEGORIES);
});

/* ─── админ ──────────────────────────────────────────────────────────── */

/** Сравнение постоянного времени — чтобы пароль нельзя было подобрать по задержке. */
function samePassword(given) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const isAdmin = (req) => adminTokens.has(req.get('X-Admin-Token') ?? '');

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return next(new ApiError(401, 'Сначала войдите в админку'));
  next();
}

api.post('/admin/login', (req, res) => {
  if (!samePassword(req.body?.password)) throw new ApiError(401, 'Пароль не подошёл');

  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.add(token);
  res.json({ token });
});

api.post('/admin/logout', (req, res) => {
  adminTokens.delete(req.get('X-Admin-Token') ?? '');
  res.status(204).end();
});

/** Фронт спрашивает при загрузке страницы: показывать ли админские кнопки. */
api.get('/admin/me', (req, res) => {
  res.json({ admin: isAdmin(req) });
});

/** Список всех роликов для панели — без пагинации, зато с размером файла. */
api.get('/admin/socks', requireAdmin, (req, res) => {
  res.json(catalog().sort(SORTERS.new).map(publicSock));
});

/* ─── профиль ────────────────────────────────────────────────────────── */

const uploadsOf = (id) => store.all().filter((sock) => sock.ownerId === id);

function commentsCountOf(id) {
  let n = 0;
  for (const thread of COMMENTS.values()) n += thread.filter((c) => c.authorId === id).length;
  return n;
}

/** Профиль плюс цифры, которые видно на карточке профиля. */
function withStats(profile) {
  return {
    ...profiles.publicProfile(profile),
    socks: uploadsOf(profile.id).length,
    comments: commentsCountOf(profile.id),
  };
}

function cleanNick(raw) {
  const nick = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (nick.length < 2) throw new ApiError(422, 'Ник короче двух символов не найдут в барабане');
  if (nick.length > profiles.NICK_MAX) {
    throw new ApiError(422, `Ник не длиннее ${profiles.NICK_MAX} символов`);
  }
  return nick;
}

/** Первый заход заводит гостя и выдаёт токен — дальше фронт шлёт его заголовком. */
api.get('/me', (req, res) => {
  const profile = req.profile ?? profiles.create();
  res.json({ ...withStats(profile), token: profile.token });
});

api.patch('/me', (req, res) => {
  const me = mustBeMe(req);
  const patch = {};

  if (req.body?.nick !== undefined) patch.nick = cleanNick(req.body.nick);
  if (req.body?.bio !== undefined) {
    const bio = String(req.body.bio).trim();
    if (bio.length > profiles.BIO_MAX) {
      throw new ApiError(422, `Описание не длиннее ${profiles.BIO_MAX} символов`);
    }
    patch.bio = bio;
  }
  if (req.body?.pal !== undefined) {
    patch.pal = intParam(req.body.pal, { min: 0, max: 9, fallback: me.pal });
  }

  res.json(withStats(profiles.update(me.id, patch)));
});

api.post('/me/avatar', avatarUpload.single('avatar'), (req, res) => {
  if (!req.profile) { dropFile(req.file); throw new ApiError(401, 'Профиль не найден. Обновите страницу.'); }
  if (!req.file) throw new ApiError(422, 'Картинка не приложена');

  res.json(withStats(profiles.setAvatar(req.profile.id, req.file.path)));
});

/** Убрать загруженную аватарку — вернётся рисованный носок. */
api.delete('/me/avatar', (req, res) => {
  const me = mustBeMe(req);
  res.json(withStats(profiles.clearAvatar(me.id)));
});

/** Чужой профиль: то же самое, но без токена и вместе с его носками. */
api.get('/profiles/:id', (req, res) => {
  const profile = profiles.byId(req.params.id);
  if (!profile) throw new ApiError(404, 'Такого гостя в барабане не было');

  res.json({
    ...withStats(profile),
    items: uploadsOf(profile.id).map((sock) => publicSock(fromUpload(sock))),
  });
});

/* ─── лента ──────────────────────────────────────────────────────────── */

api.get('/socks', (req, res) => {
  const cat = req.query.cat ?? 'Всё';
  const sort = req.query.sort ?? 'new';
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const offset = intParam(req.query.offset, { min: 0, max: 1e6, fallback: 0 });
  const limit = intParam(req.query.limit, { min: 1, max: 60, fallback: 12 });

  if (!CATEGORIES.includes(cat)) throw new ApiError(404, `Нет такой категории: ${cat}`);
  if (!SORTERS[sort]) throw new ApiError(422, `Неизвестная сортировка: ${sort}`);

  const found = catalog().filter((s) => matches(s, cat, q)).sort(SORTERS[sort]);

  res.json({
    total: found.length,
    offset,
    items: found.slice(offset, offset + limit).map(publicSock),
  });
});

/** Приём ролика: кладём файл, спрашиваем у ffprobe длительность, режем случайный кадр. */
api.post('/socks', upload.single('video'), async (req, res) => {
  const file = req.file;

  /* Проверка после multer: иначе пришлось бы отвергать запрос, не дочитав тело. */
  if (!isAdmin(req)) { dropFile(file); throw new ApiError(401, 'Заливать ролики может только админ'); }
  if (!file) throw new ApiError(422, 'Файл не приложен');

  try {
    const title = String(req.body.title ?? '').trim().slice(0, 120);
    if (!title) throw new ApiError(422, 'Без названия носок не найдут');

    const cats = parseCats(req.body.cats);
    const desc = String(req.body.desc ?? '').trim().slice(0, 400)
      || 'Загружено вручную. Обстоятельства стирки выясняются.';

    const duration = await probeDuration(file.path);
    if (!duration) throw new ApiError(415, 'ffmpeg не смог это прочитать. Точно видео?');

    const at = randomTimestamp(duration);
    const thumbFile = path.join(store.THUMB_DIR, path.parse(file.filename).name + '.jpg');
    await grabFrame(file.path, at, thumbFile);

    const sock = store.add({
      id: 'up' + crypto.randomBytes(6).toString('hex'),
      title,
      cats,
      desc,
      tags: cats.map((c) => '#' + c.toLowerCase()),
      dur: Math.round(duration),
      thumbAt: at,
      views: 0,
      likes: 0,
      pal: Math.floor(Math.random() * 10),
      ownerId: req.profile?.id ?? null,
      createdAt: new Date().toISOString(),
      videoFile: file.path,
      thumbFile,
      sizeMb: +(file.size / 1048576).toFixed(1),
    });

    res.status(201).json(publicSock(fromUpload(sock)));
  } catch (err) {
    dropFile(file);
    throw err;
  }
});

/** Открыли карточку — засчитываем просмотр. Тут это единственный источник цифр. */
api.get('/socks/:id', (req, res) => {
  const sock = mustFind(req.params.id);

  if (req.query.count !== 'false') {
    store.update(sock.id, { views: sock.views + 1 });
    sock.views += 1;
  }

  res.json(publicSock(sock));
});

/** Правка карточки из админки: что пришло, то и меняем. */
api.patch('/socks/:id', requireAdmin, (req, res) => {
  const sock = store.byId(req.params.id);
  if (!sock) throw new ApiError(404, 'Носок не найден');

  const patch = {};

  if (req.body?.title !== undefined) {
    const title = String(req.body.title).trim().slice(0, 120);
    if (!title) throw new ApiError(422, 'Ролику нужно название');
    patch.title = title;
  }

  if (req.body?.desc !== undefined) {
    const desc = String(req.body.desc).trim();
    if (desc.length > 400) throw new ApiError(422, 'Описание не длиннее 400 символов');
    patch.desc = desc;
  }

  if (req.body?.cats !== undefined) patch.cats = parseCats(req.body.cats);
  if (req.body?.tags !== undefined) patch.tags = parseTags(req.body.tags);

  if (!Object.keys(patch).length) throw new ApiError(422, 'Нечего менять');

  res.json(publicSock(fromUpload(store.update(sock.id, patch))));
});

/** Новый случайный кадр для превью — если попался неудачный. */
api.post('/socks/:id/reshoot', requireAdmin, async (req, res) => {
  const sock = store.byId(req.params.id);
  if (!sock) throw new ApiError(404, 'Носок не найден');

  const at = randomTimestamp(sock.dur);
  await grabFrame(sock.videoFile, at, sock.thumbFile);
  store.update(sock.id, { thumbAt: at });

  res.json({ ...publicSock(fromUpload(store.byId(sock.id))), reshotAt: at });
});

api.delete('/socks/:id', requireAdmin, (req, res) => {
  if (!store.byId(req.params.id)) throw new ApiError(404, 'Носок не найден');

  store.remove(req.params.id);
  COMMENTS.delete(req.params.id);
  LIKES.delete(req.params.id);
  res.status(204).end();
});

api.post('/socks/:id/like', (req, res) => {
  const sock = mustFind(req.params.id);
  const liked = req.query.liked !== 'false';

  LIKES.set(sock.id, liked ? 1 : 0);
  res.json({ id: sock.id, likes: sock.likes + likesOf(sock.id), liked });
});

api.get('/socks/:id/comments', (req, res) => {
  const thread = commentsOf(mustFind(req.params.id).id);
  res.json(thread.map((c) => publicComment(c, req.profile?.id)));
});

api.post('/socks/:id/comments', (req, res) => {
  const sock = mustFind(req.params.id);
  const me = mustBeMe(req);
  const text = String(req.body?.text ?? '').trim();

  if (!text) throw new ApiError(422, 'Пустой комментарий никого не согреет');
  if (text.length > 160) throw new ApiError(422, 'Не длиннее 160 символов');

  const thread = commentsOf(sock.id);
  const comment = {
    id: `${sock.id}-c${Date.now().toString(36)}`,
    authorId: me.id,
    author: me.nick,
    text,
    likes: 0,
  };
  thread.unshift(comment);

  res.status(201).json(publicComment(comment, me.id));
});

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ detail: 'Такого метода нет' }));

// ролики и превью; express.static сам умеет Range, поэтому перемотка работает
app.use('/uploads', express.static(store.UPLOAD_DIR, { maxAge: '1h', index: false }));

app.use(express.static(FRONTEND));
app.get('/', (req, res) => res.sendFile(path.join(FRONTEND, 'index.html')));

app.use((err, req, res, next) => {
  dropFile(req.file);

  if (err instanceof ApiError) return res.status(err.status).json({ detail: err.detail });
  if (err instanceof multer.MulterError) {
    const limit = req.path.endsWith('/avatar') ? AVATAR_MB : MAX_MB;
    const detail = err.code === 'LIMIT_FILE_SIZE'
      ? `Файл больше ${limit} МБ`
      : `Не смог принять файл: ${err.message}`;
    return res.status(413).json({ detail });
  }

  console.error(err);
  res.status(500).json({ detail: 'Что-то застряло в барабане' });
});

app.listen(PORT, async () => {
  console.log(`LostSocks крутится на http://127.0.0.1:${PORT}`);
  console.log(`Роликов в каталоге: ${store.all().length}, лимит на файл: ${MAX_MB} МБ`);

  if (ADMIN_GENERATED) {
    console.log(`Пароль админки на этот запуск: ${ADMIN_PASSWORD}`);
    console.log('Чтобы он не менялся при рестарте, задайте ADMIN_PASSWORD в окружении');
  }

  if (!(await ffmpegReady())) {
    console.warn('ffmpeg/ffprobe не найдены — загрузка видео работать не будет');
  }
});
