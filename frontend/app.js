/* Фронт LostSocks. Данные — из API, рисованные носки для аватарок — из socks.js */

const API = location.protocol === 'file:' ? 'http://127.0.0.1:8000/api' : '/api';
const $ = (s) => document.querySelector(s);

const TOKEN_KEY = 'ls_token';
const ADMIN_KEY = 'ls_admin';
const token = () => localStorage.getItem(TOKEN_KEY) || '';
const adminToken = () => localStorage.getItem(ADMIN_KEY) || '';

async function api(path, opts) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Sock-Token': token(),
      'X-Admin-Token': adminToken(),
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Сервер отвечает ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const state = { cat: 'Всё', q: '', sort: 'new', limit: 12, total: 0, liked: new Set(), cur: null, me: null, admin: false, cats: [] };

const fmtViews = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',') + ' тыс.' : n);
const fmtTime = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

const plural = (n, forms) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1];
  return forms[2];
};

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ─── аватарки ───────────────────────────────────────────────────────── */

/* фронт можно открыть файлом с диска — тогда /uploads/... надо дописать до полного адреса */
const ORIGIN = API.replace(/\/api$/, '');

const AVA_PATTERNS = ['stripes', 'dots', 'argyle', 'zigzag', 'terry', ''];

/** Узор носка-заглушки: у одного профиля он всегда один и тот же. */
function patternOf(seed) {
  let sum = 0;
  for (const ch of String(seed ?? '')) sum += ch.codePointAt(0);
  return AVA_PATTERNS[sum % AVA_PATTERNS.length];
}

/**
 * Загруженная картинка, иначе рисованный носок, иначе первая буква ника.
 * @param {object} who { id, nick, pal, avatar }
 */
function avaHTML(who, size) {
  if (!who) return '';
  if (who.avatar) return `<img class="ava__img" src="${ORIGIN}${who.avatar}" alt="" loading="lazy">`;
  if (who.pal === null || who.pal === undefined) {
    return `<span class="ava__letter">${esc((who.nick || '?')[0].toUpperCase())}</span>`;
  }
  const seed = who.id || who.nick;
  return sockSVG({ id: 'ava' + seed, pal: who.pal, pattern: patternOf(seed), cuff: true }, size);
}

/* у комментария автор разложен по отдельным полям */
const authorOf = (c) => ({ id: c.authorId, nick: c.author, pal: c.authorPal, avatar: c.authorAvatar });

/* ─── возрастной фильтр ──────────────────────────────────────────────── */

const gate = $('#gate');
if (!gate) {
  /* разметку гейта могли вырезать — это не повод ронять остальную страницу */
} else if (sessionStorage.getItem('ls_gate') === '1') {
  gate.remove();
} else {
  $('#gateSock').innerHTML = sockSVG({ id: 'gate', pal: 3, pattern: 'stripes', cuff: true }, 120);
  $('#gateYes').onclick = () => {
    sessionStorage.setItem('ls_gate', '1');
    gate.classList.add('gate--out');
    setTimeout(() => gate.remove(), 350);
  };
  $('#gateNo').onclick = (e) => {
    const b = e.currentTarget;
    const n = (b.dataset.n = String(+(b.dataset.n || 0) + 1));
    b.textContent = ['Точно нет?', 'А если подумать?', 'Ну ладно, проходите'][Math.min(2, +n - 1)];
    if (+n >= 3) $('#gateYes').click();
  };
}

/* ─── категории ──────────────────────────────────────────────────────── */

async function initChips() {
  let cats;
  try {
    cats = await api('/categories');
  } catch {
    cats = ['Всё'];
    toast('Бэкенд молчит. Запустите npm start в папке backend');
  }
  state.cats = cats;

  $('#chips').innerHTML = cats
    .map((c) => `<button class="chip${c === 'Всё' ? ' chip--on' : ''}" data-cat="${c}">${c}</button>`)
    .join('');

  $('#upCats').innerHTML = cats
    .filter((c) => c !== 'Всё')
    .map((c) => `<label class="pick"><input type="checkbox" value="${c}"><span>${c}</span></label>`)
    .join('');
}

$('#chips').onclick = (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.cat = b.dataset.cat;
  state.limit = 12;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('chip--on', c === b));
  load();
};

/* ─── лента ──────────────────────────────────────────────────────────── */

function card(d) {
  return `
<article class="card card--vid" data-id="${d.id}" data-video="${d.video}" data-at="${d.thumbAt ?? 0}" tabindex="0">
  <div class="card__thumb" style="--c1:${palOf(d.pal).base}">
    <img class="card__shot" src="${d.thumb}" alt="" loading="lazy" decoding="async">
    <span class="card__dur">${fmtTime(d.dur)}</span>
    <div class="card__hover">Смотреть цикл</div>
  </div>
  <h3 class="card__title">${esc(d.title)}</h3>
  <div class="card__meta">
    <span>${fmtViews(d.views)} ${plural(d.views, ['стирка', 'стирки', 'стирок'])}</span>
    <span class="card__like">♥ ${fmtViews(d.likes)}</span>
  </div>
</article>`;
}

let loading = false;

async function load() {
  if (loading) return;
  loading = true;
  $('#grid').classList.add('grid--busy');

  const qs = new URLSearchParams({ cat: state.cat, q: state.q, sort: state.sort, limit: state.limit });

  try {
    const data = await api('/socks?' + qs);
    state.total = data.total;
    $('#grid').innerHTML = data.items.map(card).join('');
    $('#empty').hidden = data.total > 0;
    $('#moreBtn').hidden = state.limit >= data.total;
    $('#gridCount').textContent = `${data.total} ${plural(data.total, ['носок', 'носка', 'носков'])}`;
  } catch (err) {
    $('#grid').innerHTML = '';
    $('#empty').hidden = false;
    $('#empty').textContent = err.message;
    $('#moreBtn').hidden = true;
  }

  $('#gridTitle').textContent = state.q
    ? `Поиск: «${state.q}»`
    : state.cat === 'Всё' ? 'Свежее из барабана' : state.cat;

  $('#grid').classList.remove('grid--busy');
  loading = false;
}

let typing;
$('#searchInput').oninput = (e) => {
  state.q = e.target.value.trim();
  state.limit = 12;
  clearTimeout(typing);
  typing = setTimeout(load, 220);
};
$('#searchForm').onsubmit = (e) => { e.preventDefault(); load(); };
$('#sortSel').onchange = (e) => { state.sort = e.target.value; load(); };
$('#moreBtn').onclick = () => { state.limit = Math.min(state.limit + 12, 60); load(); };

$('#grid').onclick = (e) => {
  const c = e.target.closest('.card');
  if (c) open(c.dataset.id);
};
$('#grid').onkeydown = (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('card')) open(e.target.dataset.id);
};

/* превью по наведению: ролик подгружается только когда на него навели */
let hover = null;

function stopHover() {
  if (!hover) return;
  hover.video.remove();
  hover = null;
}

$('#grid').addEventListener('mouseover', (e) => {
  const card = e.target.closest('.card--vid');
  if (!card || hover?.card === card) return;
  stopHover();

  const video = document.createElement('video');
  video.className = 'card__preview';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = card.dataset.video;

  video.addEventListener('loadedmetadata', () => {
    video.currentTime = Math.min(+card.dataset.at || 0, Math.max(0, video.duration - 1));
    video.play().catch(() => { /* автовоспроизведение могли запретить */ });
  });

  card.querySelector('.card__thumb').append(video);
  hover = { card, video };
});

$('#grid').addEventListener('mouseout', (e) => {
  if (hover && !hover.card.contains(e.relatedTarget)) stopHover();
});

/* ─── плеер ──────────────────────────────────────────────────────────── */

let playing = false, vid = null;

const cmtLi = (c) => `
<li class="cmt${c.mine ? ' cmt--mine' : ''}">
  <div class="cmt__ava">${avaHTML(authorOf(c), 32)}</div>
  <div><b>${esc(c.author)}</b><p>${esc(c.text)}</p><span>♥ ${c.likes}</span></div>
</li>`;

async function open(id) {
  let d, comments;
  try {
    [d, comments] = await Promise.all([api('/socks/' + id), api(`/socks/${id}/comments`)]);
  } catch (err) {
    return toast(err.message);
  }

  state.cur = d;
  vid = null;

  $('#stage').innerHTML =
    `<video id="vid" class="player__video" src="${d.video}" playsinline preload="metadata"></video>`;
  vid = $('#vid');
  vid.addEventListener('timeupdate', syncTrack);
  vid.addEventListener('ended', () => play(false));

  /* пересъёмка и удаление — только из-под админки */
  $('#reshootBtn').hidden = !state.admin;
  $('#delBtn').hidden = !state.admin;

  $('#mTitle').textContent = d.title;
  $('#mViews').textContent =
    `${fmtViews(d.views)} ${plural(d.views, ['стирка', 'стирки', 'стирок'])} · ` +
    (d.age === 0 ? 'сегодня' : `${d.age} ${plural(d.age, ['день', 'дня', 'дней'])} назад`);
  $('#mDesc').textContent = d.desc;
  $('#mTags').innerHTML = d.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  $('#likeCount').textContent = fmtViews(d.likes);
  $('#likeBtn').classList.toggle('act--on', state.liked.has(d.id));

  $('#cmtList').innerHTML = comments.map(cmtLi).join('');
  $('#cmtCount').textContent = comments.length;

  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
  play(true);
}

function showTrack(at, total) {
  $('#trackFill').style.width = (total ? (at / total) * 100 : 0) + '%';
  $('#time').textContent = fmtTime(Math.round(at)) + ' / ' + fmtTime(Math.round(total));
}

const syncTrack = () => showTrack(vid.currentTime, vid.duration || state.cur.dur);

function play(on) {
  playing = on;

  if (vid) on ? vid.play().catch(() => { playing = false; }) : vid.pause();

  $('#playIcon').setAttribute('d', on ? 'M6 4h4v16H6zM14 4h4v16h-4z' : 'M7 4l13 8-13 8z');
}

$('#playBtn').onclick = () => play(!playing);
$('#track').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  if (vid) vid.currentTime = ((e.clientX - r.left) / r.width) * (vid.duration || state.cur.dur);
};

function close() {
  play(false);
  if (vid) { vid.removeAttribute('src'); vid.load(); vid = null; }
  $('#stage').innerHTML = '';
  $('#modal').hidden = true;
  document.body.style.overflow = '';
}
document.querySelectorAll('[data-close]').forEach((el) => (el.onclick = close));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#modal').hidden) close();
  else if (!$('#adm').hidden) closeAdm();
  else if (!$('#prof').hidden) closeProf();
});

$('#likeBtn').onclick = async () => {
  const d = state.cur;
  const liked = !state.liked.has(d.id);
  try {
    const res = await api(`/socks/${d.id}/like?liked=${liked}`, { method: 'POST' });
    liked ? state.liked.add(d.id) : state.liked.delete(d.id);
    $('#likeBtn').classList.toggle('act--on', liked);
    $('#likeCount').textContent = fmtViews(res.likes);
  } catch (err) {
    toast(err.message);
  }
};

$('#cmtForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#cmtInput').value.trim();
  if (!text) return;
  try {
    const c = await api(`/socks/${state.cur.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    $('#cmtList').insertAdjacentHTML('afterbegin', cmtLi(c));
    $('#cmtCount').textContent = +$('#cmtCount').textContent + 1;
    $('#cmtInput').value = '';
  } catch (err) {
    toast(err.message);
  }
};

/* ─── профиль ────────────────────────────────────────────────────────── */

const BIO_MAX = 160;

/* выбранный, но ещё не сохранённый цвет носка — до «Сохранить» его видно только в профиле */
let pickedPal = 0;

/** Аватарка в шапке и над полем комментария — везде одна и та же. */
function paintMe() {
  const me = state.me;
  $('#avatarBtn').innerHTML = avaHTML(me, 36);
  $('#avatarBtn').title = me ? me.nick : 'Профиль';
  $('#cmtAva').innerHTML = avaHTML(me, 32);
}

/** Первый заход заводит гостя: сервер выдаёт токен, дальше он лежит в localStorage. */
async function loadMe() {
  try {
    const me = await api('/me');
    if (me.token) localStorage.setItem(TOKEN_KEY, me.token);
    state.me = me;
  } catch {
    state.me = null;  /* бэкенд молчит — профиля просто не будет */
  }
  paintMe();
}

function fillProfile(me) {
  state.me = me;
  pickedPal = me.pal;

  $('#profAva').innerHTML = avaHTML(me, 96);
  $('#profNick').textContent = me.nick;
  $('#profBio').textContent = me.bio || 'О себе пока ничего. Только запах порошка.';
  $('#profBio').classList.toggle('prof__bio--empty', !me.bio);
  $('#profStats').textContent = [
    `${me.socks} ${plural(me.socks, ['носок', 'носка', 'носков'])}`,
    `${me.comments} ${plural(me.comments, ['комментарий', 'комментария', 'комментариев'])}`,
    'в барабане с ' + new Date(me.createdAt).toLocaleDateString('ru-RU'),
  ].join(' · ');

  $('#profAvaDrop').hidden = !me.avatar;
  $('#profNickIn').value = me.nick;
  $('#profBioIn').value = me.bio;
  countBio();

  $('#profPals').innerHTML = Array.from({ length: 10 }, (_, i) => `
    <button type="button" class="pal${i === me.pal ? ' pal--on' : ''}" data-pal="${i}"
            style="--p:${palOf(i).base}" title="${palName(i)}" aria-label="${palName(i)}"></button>`).join('');

  paintMe();
}

const countBio = () => {
  const left = BIO_MAX - $('#profBioIn').value.length;
  $('#profLeft').textContent = `Осталось ${left} ${plural(left, ['символ', 'символа', 'символов'])}`;
};

/** Свои залитые носки — те же карточки, что и в ленте. */
async function fillMySocks() {
  const box = $('#profSocks');
  box.innerHTML = '<p class="prof__none">Загружаю…</p>';

  try {
    const data = await api('/profiles/' + state.me.id);
    box.innerHTML = data.items.length
      ? data.items.map(card).join('')
      : '<p class="prof__none">Пока пусто. Залейте носок — он появится здесь.</p>';
  } catch (err) {
    box.innerHTML = `<p class="prof__none">${esc(err.message)}</p>`;
  }
}

async function openProf() {
  await loadMe();  /* заодно освежает счётчики носков и комментариев */
  if (!state.me) return toast('Профиль не поднялся: бэкенд не отвечает');

  fillProfile(state.me);
  $('#prof').hidden = false;
  document.body.style.overflow = 'hidden';
  fillMySocks();
}

const closeProf = () => { $('#prof').hidden = true; document.body.style.overflow = ''; };

/* свой носок из профиля открывается в том же плеере */
$('#profSocks').onclick = (e) => {
  const c = e.target.closest('.card');
  if (!c) return;
  closeProf();
  open(c.dataset.id);
};

$('#avatarBtn').onclick = openProf;
document.querySelectorAll('[data-profclose]').forEach((el) => (el.onclick = closeProf));
$('#profBioIn').oninput = countBio;

/* цвет носка-заглушки переключается сразу, сохраняется вместе с формой */
$('#profPals').onclick = (e) => {
  const b = e.target.closest('.pal');
  if (!b) return;
  pickedPal = +b.dataset.pal;
  document.querySelectorAll('.pal').forEach((p) => p.classList.toggle('pal--on', p === b));
  $('#profAva').innerHTML = avaHTML({ ...state.me, pal: pickedPal }, 96);
};

$('#profForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#profSave').disabled = true;

  try {
    const me = await api('/me', {
      method: 'PATCH',
      body: JSON.stringify({
        nick: $('#profNickIn').value,
        bio: $('#profBioIn').value,
        pal: pickedPal,
      }),
    });
    fillProfile(me);
    if (!$('#modal').hidden && state.cur) refreshComments();
    toast('Записали. Теперь вас так и зовут');
  } catch (err) {
    toast(err.message);
  }

  $('#profSave').disabled = false;
};

/* аватарка уходит формой, поэтому Content-Type ставит сам браузер */
$('#profFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  if (file.size > 5 * 1048576) return toast('Картинка больше 5 МБ. Постирайте её на 60°');

  const form = new FormData();
  form.append('avatar', file);

  $('#profPick').classList.add('btn--busy');
  try {
    const res = await fetch(API + '/me/avatar', {
      method: 'POST',
      headers: { 'X-Sock-Token': token() },
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || `Сервер отвечает ${res.status}`);

    fillProfile(body);
    if (!$('#modal').hidden && state.cur) refreshComments();
    toast('Аватарка на месте');
  } catch (err) {
    toast(err.message);
  }
  $('#profPick').classList.remove('btn--busy');
};

$('#profAvaDrop').onclick = async () => {
  try {
    fillProfile(await api('/me/avatar', { method: 'DELETE' }));
    if (!$('#modal').hidden && state.cur) refreshComments();
    toast('Вернули рисованный носок');
  } catch (err) {
    toast(err.message);
  }
};

/** Подписи в открытой ветке после смены ника или аватарки. */
async function refreshComments() {
  try {
    const comments = await api(`/socks/${state.cur.id}/comments`);
    $('#cmtList').innerHTML = comments.map(cmtLi).join('');
  } catch { /* ветка обновится при следующем открытии */ }
}

/* ─── мелочи ─────────────────────────────────────────────────────────── */

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('toast--on'));
  clearTimeout(toastT);
  toastT = setTimeout(() => {
    t.classList.remove('toast--on');
    setTimeout(() => (t.hidden = true), 300);
  }, 3400);
}

/* ─── админка ────────────────────────────────────────────────────────── */

let picked = null;

const openAdm = () => {
  $('#adm').hidden = false;
  document.body.style.overflow = 'hidden';
  if (state.admin) loadAdmList();
  else $('#admPass').focus();
};
const closeAdm = () => { $('#adm').hidden = true; document.body.style.overflow = ''; };

$('#adminBtn').onclick = openAdm;
document.querySelectorAll('[data-admclose]').forEach((el) => (el.onclick = closeAdm));

/** Показываем панель или форму входа — в зависимости от того, признал ли нас сервер. */
function setAdmin(on) {
  state.admin = on;
  $('#admPanel').hidden = !on;
  $('#admLogin').hidden = on;
  $('#adminBtn').textContent = on ? 'Админка' : 'Админка';
  if (!on) localStorage.removeItem(ADMIN_KEY);
}

async function checkAdmin() {
  try {
    const { admin } = await api('/admin/me');
    setAdmin(admin);
    if (admin) loadAdmList();
  } catch {
    setAdmin(false);
  }
}

$('#admLogin').onsubmit = async (e) => {
  e.preventDefault();
  const password = $('#admPass').value;
  if (!password) return toast('Введите пароль');

  try {
    const { token } = await api('/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    localStorage.setItem(ADMIN_KEY, token);
    $('#admPass').value = '';
    setAdmin(true);
    loadAdmList();
    toast('Вошли. Теперь можно заливать ролики');
  } catch (err) {
    toast(err.message);
  }
};

$('#admOut').onclick = async () => {
  try { await api('/admin/logout', { method: 'POST' }); } catch { /* токен всё равно выбрасываем */ }
  setAdmin(false);
  closeAdm();
  toast('Вышли из админки');
};

/* ─── список роликов в панели ────────────────────────────────────────── */

let admItems = [];

const admRow = (d) => `
<div class="adm__row" data-id="${d.id}">
  <img class="adm__shot" src="${d.thumb}" alt="" loading="lazy">
  <div class="adm__info">
    <b>${esc(d.title)}</b>
    <span>${fmtTime(d.dur)} · ${d.sizeMb} МБ · ${fmtViews(d.views)} ${plural(d.views, ['стирка', 'стирки', 'стирок'])} · кадр с ${fmtTime(Math.round(d.thumbAt))}</span>
  </div>
  <div class="adm__acts">
    <button class="btn btn--sm" data-act="edit">Изменить</button>
    <button class="btn btn--sm" data-act="reshoot">Другой кадр</button>
    <button class="btn btn--sm btn--danger" data-act="del">Удалить</button>
  </div>
</div>`;

/** Форма правки раскрывается прямо под строкой списка. */
const admEdit = (d) => `
<form class="adm__edit" data-id="${d.id}">
  <div class="up__label">Название</div>
  <input class="up__in" name="title" maxlength="120" value="${esc(d.title)}">

  <div class="up__label">Описание</div>
  <textarea class="up__in" name="desc" rows="2" maxlength="400">${esc(d.desc || '')}</textarea>

  <div class="up__label">Категории</div>
  <div class="up__cats">
    ${state.cats.filter((c) => c !== 'Всё').map((c) => `
      <label class="pick">
        <input type="checkbox" name="cats" value="${c}"${d.cats.includes(c) ? ' checked' : ''}>
        <span>${c}</span>
      </label>`).join('')}
  </div>

  <div class="up__label">Теги через запятую</div>
  <input class="up__in" name="tags" value="${esc((d.tags || []).join(', '))}" placeholder="барабан, 40градусов">

  <div class="adm__edit-foot">
    <button class="btn btn--sm" type="button" data-act="cancel">Отмена</button>
    <button class="btn btn--primary btn--sm" type="submit">Сохранить</button>
  </div>
</form>`;

async function loadAdmList() {
  try {
    admItems = await api('/admin/socks');
    $('#admList').innerHTML = admItems.length
      ? admItems.map(admRow).join('')
      : '<p class="adm__empty">Пока ничего не залито</p>';
    $('#admCount').textContent = admItems.length ? `(${admItems.length})` : '';
  } catch (err) {
    $('#admList').innerHTML = `<p class="adm__empty">${esc(err.message)}</p>`;
  }
}

function closeEdit() {
  $('#admList').querySelector('.adm__edit')?.remove();
  $('#admList').querySelector('.adm__row--open')?.classList.remove('adm__row--open');
}

function openEdit(row) {
  const d = admItems.find((x) => x.id === row.dataset.id);
  if (!d) return;

  const already = row.classList.contains('adm__row--open');
  closeEdit();
  if (already) return;

  row.classList.add('adm__row--open');
  row.insertAdjacentHTML('afterend', admEdit(d));
}

$('#admList').onclick = async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;

  if (btn.dataset.act === 'cancel') return closeEdit();

  const row = btn.closest('.adm__row');
  if (btn.dataset.act === 'edit') return openEdit(row);

  const id = row.dataset.id;
  const title = row.querySelector('b').textContent;

  btn.disabled = true;
  try {
    if (btn.dataset.act === 'reshoot') {
      const sock = await api(`/socks/${id}/reshoot`, { method: 'POST' });
      toast(`Новый кадр — с ${fmtTime(Math.round(sock.reshotAt))}`);
    } else {
      if (!confirm(`Удалить «${title}» вместе с файлом?`)) return;
      await api('/socks/' + id, { method: 'DELETE' });
      toast('Ролик удалён');
    }
    await Promise.all([loadAdmList(), load()]);
  } catch (err) {
    toast(err.message);
  }
  btn.disabled = false;
};

$('#admList').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = form.dataset.id;
  const data = new FormData(form);

  const body = {
    title: data.get('title'),
    desc: data.get('desc'),
    cats: data.getAll('cats'),
    tags: data.get('tags'),
  };
  if (!body.cats.length) return toast('Оставьте хотя бы одну категорию');

  form.querySelector('[type=submit]').disabled = true;
  try {
    const sock = await api('/socks/' + id, { method: 'PATCH', body: JSON.stringify(body) });
    closeEdit();
    await Promise.all([loadAdmList(), load()]);

    /* если этот же ролик открыт в плеере — подтягиваем правки туда же */
    if (state.cur?.id === id) {
      state.cur = { ...state.cur, ...sock };
      $('#mTitle').textContent = sock.title;
      $('#mDesc').textContent = sock.desc;
      $('#mTags').innerHTML = sock.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    }
    toast('Сохранено');
  } catch (err) {
    toast(err.message);
    form.querySelector('[type=submit]').disabled = false;
  }
};

/* ─── форма загрузки ─────────────────────────────────────────────────── */

function resetDrop() {
  picked = null;
  $('#drop').classList.remove('drop--set');
  $('#dropName').textContent = 'Перетащите ролик или выберите файл';
  $('#dropHint').textContent = 'mp4, webm, mov, mkv — до 300 МБ';
}

function setFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|mkv|m4v|avi|ogv)$/i.test(file.name)) {
    return toast('Это не видео. Нужен mp4, webm, mov или mkv');
  }
  picked = file;
  $('#dropName').textContent = file.name;
  $('#dropHint').textContent = (file.size / 1048576).toFixed(1) + ' МБ';
  $('#drop').classList.add('drop--set');
  if (!$('#upTitle').value) $('#upTitle').value = file.name.replace(/\.[^.]+$/, '');
}

$('#upFile').onchange = (e) => setFile(e.target.files[0]);

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.add('drop--over');
}));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('drop--over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  setFile(e.dataTransfer.files[0]);
});

/* fetch не умеет показывать прогресс отправки, поэтому здесь XHR */
function sendVideo(form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API + '/socks');
    xhr.setRequestHeader('X-Admin-Token', adminToken());
    xhr.setRequestHeader('X-Sock-Token', token());
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* сервер ответил не json */ }
      xhr.status === 201 ? resolve(body) : reject(new Error(body.detail || `Сервер отвечает ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Связь с барабаном оборвалась'));
    xhr.send(form);
  });
}

$('#upForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!picked) return toast('Сначала выберите ролик');

  const title = $('#upTitle').value.trim();
  if (!title) return toast('Ролику нужно название');

  const form = new FormData();
  form.append('video', picked);
  form.append('title', title);
  form.append('desc', $('#upDesc').value.trim());
  [...document.querySelectorAll('#upCats input:checked')].forEach((c) => form.append('cats', c.value));

  $('#upSend').disabled = true;
  $('#upProgress').hidden = false;

  try {
    const sock = await sendVideo(form, (share) => {
      $('#upBar').style.width = (share * 100).toFixed(0) + '%';
      $('#upSend').textContent = share < 1 ? `Отправляю… ${(share * 100) | 0}%` : 'Режу кадр…';
    });

    $('#upForm').reset();
    resetDrop();

    state.cat = 'Всё';
    state.q = '';
    $('#searchInput').value = '';
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('chip--on', c.dataset.cat === 'Всё'));
    await Promise.all([load(), loadAdmList()]);
    toast(`Ролик в ленте. Кадр взят с ${fmtTime(Math.round(sock.thumbAt))}`);
  } catch (err) {
    toast(err.message);
  }

  $('#upSend').disabled = false;
  $('#upSend').textContent = 'Залить';
  $('#upProgress').hidden = true;
  $('#upBar').style.width = '0%';
};

/* ─── админские кнопки в плеере ──────────────────────────────────────── */

$('#reshootBtn').onclick = async () => {
  try {
    const sock = await api(`/socks/${state.cur.id}/reshoot`, { method: 'POST' });
    toast(`Новый кадр — с ${fmtTime(Math.round(sock.reshotAt))}`);
    load();
  } catch (err) {
    toast(err.message);
  }
};

$('#delBtn').onclick = async () => {
  if (!confirm(`Удалить «${state.cur.title}» вместе с файлом?`)) return;
  try {
    await api('/socks/' + state.cur.id, { method: 'DELETE' });
    close();
    toast('Ролик удалён');
    load();
  } catch (err) {
    toast(err.message);
  }
};

loadMe();
checkAdmin();
initChips().then(load);
