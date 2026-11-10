/* Pitchside: スマホへの通知を送るサーバー側の処理（Firebase Cloud Functions）
 * - 重要連絡（クラブ全体・チーム）が投稿されたとき → 対象の選手・スタッフへ
 * - 個別連絡（スタッフ⇔選手）が届いたとき → 相手へ
 * - 出欠を聞く予定が追加されたとき → 対象チームへ
 * - 毎日18時（日本時間）：3日以内の予定に未回答の選手へリマインド
 */
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
initializeApp();
const db = getFirestore();
const REGION = 'asia-northeast1';
const SITE = 'https://taku92445-del.github.io/pitchside/';

const isPlain = o => !!o && typeof o === 'object' && !Array.isArray(o);
function decV(v) {
  if (!isPlain(v)) return v;
  if (typeof v.__j === 'string') { try { return JSON.parse(v.__j); } catch (e) { return []; } }
  const ks = Object.keys(v);
  if (ks.length && ks.every(k => isPlain(v[k]) && typeof v[k]._i === 'number'))
    return ks.map(k => v[k]).sort((a, b) => a._i - b._i).map(x => { const y = decV(x); delete y._i; return y; });
  const o = {}; ks.forEach(k => { o[k] = decV(v[k]); }); return o;
}
const arr = x => Array.isArray(x) ? x : [];
async function state(cid, id) { const s = await db.doc(`clubs/${cid}/state/${id}`).get(); return s.exists ? decV(s.data().v) : null; }
async function tokensFor(cid, pids) {
  if (!pids.length) return [];
  const set = new Set(pids), out = [];
  const qs = await db.collection(`clubs/${cid}/tokens`).get();
  qs.forEach(d => { const t = d.data(); if (t.token && set.has(t.pid)) out.push({ token: t.token, ref: d.ref }); });
  return out;
}
async function send(cid, pids, title, body, tag) {
  const ts = await tokensFor(cid, [...new Set(pids)]);
  if (!ts.length) return;
  for (let i = 0; i < ts.length; i += 400) {
    const chunk = ts.slice(i, i + 400);
    const r = await getMessaging().sendEachForMulticast({
      tokens: chunk.map(t => t.token),
      notification: { title, body: String(body || '').slice(0, 180) },
      webpush: { fcmOptions: { link: SITE }, notification: { icon: SITE + 'icon-192.png', tag } }
    });
    r.responses.forEach((x, j) => { if (!x.success && /registration-token-not-registered|invalid-registration-token/.test((x.error && x.error.code) || '')) chunk[j].ref.delete().catch(() => {}); });
  }
}
async function audience(cid, ch) {
  const players = arr(await state(cid, 'players')), staff = arr(await state(cid, 'staff'));
  if (ch === 'team') return [...players.map(p => p.id), ...staff.map(s => s.id)];
  const m = /^sq:(.+)$/.exec(ch || '');
  if (m) return [...players.filter(p => p.squad === m[1]).map(p => p.id), ...staff.filter(s => s.squads === 'all' || arr(s.squads).includes(m[1])).map(s => s.id)];
  return [];
}
const newItems = (before, after) => { const b = new Set(arr(before).map(x => x.id)); return arr(after).filter(x => x && x.id && !b.has(x.id)); };

exports.onStateWrite = onDocumentWritten({ document: 'clubs/{cid}/state/{doc}', region: REGION }, async ev => {
  const { cid, doc } = ev.params;
  const before = ev.data.before.exists ? decV(ev.data.before.data().v) : null;
  const after = ev.data.after.exists ? decV(ev.data.after.data().v) : null;
  if (!after) return;
  if (doc.startsWith('messages@')) {
    for (const m of newItems(before, after)) {
      if (!m.imp) continue;
      const to = (await audience(cid, m.ch)).filter(id => id !== m.from);
      await send(cid, to, '重要連絡', m.text.split('\n')[0], 'msg-' + m.id);
    }
  }
  if (doc === 'events') {
    for (const e of newItems(before, after)) {
      if (!e.ask) continue;
      const to = (await audience(cid, e.sq === 'club' ? 'team' : 'sq:' + e.sq));
      await send(cid, to, '予定が追加されました', `${e.date} ${e.title}（参加・不参加を答えてください）`, 'ev-' + e.id);
    }
  }
});

exports.onDirectMessage = onDocumentWritten({ document: 'clubs/{cid}/pd/{id}', region: REGION }, async ev => {
  const { cid, id } = ev.params;
  if (!id.endsWith('_d') || !ev.data.after.exists) return;
  const pid = ev.data.after.data().pid;
  const before = ev.data.before.exists ? (decV(ev.data.before.data().v) || {}).msgs : [];
  const after = (decV(ev.data.after.data().v) || {}).msgs;
  const staff = arr(await state(cid, 'staff'));
  for (const m of newItems(before, after)) {
    if (m.from === pid) {
      const players = arr(await state(cid, 'players')), p = players.find(x => x.id === pid);
      const to = staff.filter(s => s.squads === 'all' || (p && arr(s.squads).includes(p.squad))).map(s => s.id);
      await send(cid, to, `${p ? p.name : '選手'}さんから個別連絡`, m.text, 'dm-' + m.id);
    } else {
      await send(cid, [pid], 'スタッフから個別連絡', m.text, 'dm-' + m.id);
    }
  }
});

exports.rsvpReminder = onSchedule({ schedule: '0 18 * * *', timeZone: 'Asia/Tokyo', region: REGION }, async () => {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const lim = new Date(Date.now() + 9 * 3600e3 + 3 * 864e5).toISOString().slice(0, 10);
  const clubs = await db.collection('clubs').get();
  for (const c of clubs.docs) {
    const cid = c.id;
    const events = arr(await state(cid, 'events')).filter(e => e.ask && e.date >= today && e.date <= lim);
    if (!events.length) continue;
    const players = arr(await state(cid, 'players')), rsvp = (await state(cid, 'rsvp')) || {};
    for (const e of events) {
      const yet = players.filter(p => (e.sq === 'club' || p.squad === e.sq) && !(rsvp[e.id] && rsvp[e.id][p.id])).map(p => p.id);
      await send(cid, yet, '出欠の回答をお願いします', `${e.date} ${e.title}`, 'rem-' + e.id);
    }
  }
});
