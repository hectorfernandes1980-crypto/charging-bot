export const SLOTS = ['09:00-14:00', '14:00-19:00'];
export function localNow(now = new Date(), zone = 'Europe/Moscow') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(x => [x.type, x.value]));
  return {day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute)};
}
export function week(day) {
  const d = new Date(`${day}T12:00:00Z`);
  return Array.from({length: 7}, (_, i) => new Date(+d + i * 86400000).toISOString().slice(0,10));
}
function label(day) {
  return new Intl.DateTimeFormat('ru-RU', {day: '2-digit', month: '2-digit', weekday: 'short', timeZone: 'UTC'})
    .format(new Date(`${day}T12:00:00Z`));
}
const keyboard = rows => ({inline_keyboard: rows});
const button = (text, callback_data) => ({text, callback_data});
function days(now, action) { return keyboard(week(now.day).map(d => [button(label(d), `${action}|${d}`)])); }
function slots(day, action) {
  return keyboard([1,2].flatMap(p => SLOTS.map((s,i) => [button(`Место ${p} · ${s}`, `${action}|${day}|${p}|${i}`)]))
    .concat([[button('« Назад к датам', `${action === 'book' ? 'bookdays' : 'canceldays'}|`)]]));
}
export function validSlot(day, place, slot, now, booking = true) {
  return week(now.day).includes(day) && [1,2].includes(place) && [0,1].includes(slot)
    && (!booking || day !== now.day || now.minutes < [14*60,19*60][slot]);
}
function stmt(db, sql, args = []) { return db.prepare(sql).bind(...args); }
async function first(db, sql, args = []) { return stmt(db, sql, args).first(); }
async function rows(db, sql, args = []) { return (await stmt(db, sql, args).all()).results; }

// Every statement in one D1 batch is transactional. Each mutation has a receipt
// guard; the receipt is inserted last, so concurrent/retried updates are harmless.
export async function mutate(db, updateId, operations) {
  const guard = 'NOT EXISTS (SELECT 1 FROM receipts WHERE update_id=?)';
  return db.batch([
    ...operations.map(([sql,args]) => stmt(db, sql.replaceAll('$GUARD', guard), [...args,updateId])),
    stmt(db, 'INSERT OR IGNORE INTO receipts(update_id,created) VALUES (?,?)', [updateId,Date.now()])
  ]);
}
async function renderDay(db, day) {
  const bookings = await rows(db, 'SELECT b.*, u.name FROM bookings b LEFT JOIN users u ON u.user_id=b.user_id WHERE day=?', [day]);
  return `📅 ${label(day)}\n` + [1,2].map(p => `\n🔌 Место ${p}\n` + SLOTS.map((s,i) => {
    const b = bookings.find(b => b.place === p && b.slot === i);
    return `  ${s}: ${b ? `🔴 ${b.name || 'id'+b.user_id}` : '✅ свободно'}`;
  }).join('\n')).join('\n');
}
async function telegram(env, method, payload) {
  let r;
  try {
    r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000)
    });
  } catch { throw new Error('Telegram network error'); }
  const data = await r.json();
  if (!data.ok) {
    if (method === 'editMessageText' && data.description?.includes('message is not modified')) return;
    // Permanent errors must not cause endless webhook retries.
    if (method === 'answerCallbackQuery' && data.error_code === 400) return;
    if (data.error_code === 403) return;
    throw new Error(`Telegram ${method}: ${data.error_code}`);
  }
  return data.result;
}

export async function handleUpdate(update, env, now = localNow(new Date(), env.TIME_ZONE)) {
  if (!Number.isSafeInteger(update.update_id)) return;
  const cb = update.callback_query;
  const message = cb?.message || update.message;
  const user = cb?.from || message?.from;
  if (!user || !message?.chat) return;
  const db = env.DB, uid = user.id, admin = uid === Number(env.ADMIN_USER_ID);
  const send = (text, reply_markup) => telegram(env,'sendMessage',{chat_id:message.chat.id,text, ...(reply_markup ? {reply_markup} : {})});
  const answer = (text) => cb ? telegram(env,'answerCallbackQuery',{callback_query_id:cb.id,text,show_alert:!!text}) : send(text);
  const edit = async (text, reply_markup) => {
    await telegram(env,'editMessageText',{chat_id:message.chat.id,message_id:message.message_id,text,reply_markup});
    await answer();
  };
  // Admin state and booking identities are scoped to private chats.
  if (message.chat.type !== 'private') { await answer('Открой личный чат с ботом.'); return; }
  const command = (message.text || '').trim().split(/\s/)[0].split('@')[0];
  const member = admin || !!(await first(db,'SELECT 1 FROM users WHERE user_id=? AND participant=1',[uid]));
  if (!member) { await answer(`Ты пока не в списке участников. Попроси администратора добавить тебя. Твой ID: ${uid}`); return; }
  await stmt(db, "INSERT INTO users(user_id,name) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name", [uid,(user.first_name || '').slice(0,128)]).run();
  // Lazy cleanup: no cron or permanent background process needed.
  await db.batch([
    stmt(db,'DELETE FROM bookings WHERE day<?',[now.day]),
    stmt(db,'DELETE FROM states WHERE expires<?',[Date.now()]),
    stmt(db,'DELETE FROM receipts WHERE created<?',[Date.now()-7*86400000])
  ]);
  if (cb) {
    const [action,day,p,s] = (cb.data || '').split('|');
    if (['bookdays','canceldays'].includes(action)) return edit('Выбери день:',days(now, action === 'bookdays' ? 'bookday' : 'cancelday'));
    if (!week(now.day).includes(day)) return answer('Эта кнопка устарела. Открой /week, /book или /cancel заново.');
    if (action === 'show') return edit(await renderDay(db,day),days(now,'show'));
    if (['bookday','cancelday'].includes(action)) return edit(`Выбери слот на ${label(day)}:`,slots(day, action === 'bookday' ? 'book' : 'cancel'));
    if (!['book','cancel'].includes(action) || !/^[12]$/.test(p || '') || !/^[01]$/.test(s || '')) return answer('Неизвестная кнопка. Открой /start.');
    const place = Number(p), slot = Number(s);
    if (!validSlot(day,place,slot,now,action === 'book')) return answer('Этот слот уже закончился или недоступен.');
    const existing = await first(db,'SELECT user_id FROM bookings WHERE day=? AND place=? AND slot=?',[day,place,slot]);
    if (action === 'book') {
      if (existing && existing.user_id !== uid) return answer('Этот слот уже занят.');
      await mutate(db, update.update_id, [[
        'INSERT OR IGNORE INTO bookings(day,place,slot,user_id) SELECT ?,?,?,? WHERE (?=? OR EXISTS (SELECT 1 FROM users WHERE user_id=? AND participant=1)) AND $GUARD',
        [day,place,slot,uid,uid,Number(env.ADMIN_USER_ID),uid]
      ]]);
      const current = await first(db,'SELECT user_id FROM bookings WHERE day=? AND place=? AND slot=?',[day,place,slot]);
      if (current?.user_id !== uid) return answer('Слот уже занят или действие устарело. Открой /today.');
      return edit(`✅ Твоя бронь: Место ${place}, ${SLOTS[slot]}\n\n${await renderDay(db,day)}`,days(now,'show'));
    }
    if (existing && existing.user_id !== uid) return answer('Слот занят не тобой.');
    await mutate(db,update.update_id,[['DELETE FROM bookings WHERE day=? AND place=? AND slot=? AND user_id=? AND $GUARD',[day,place,slot,uid]]]);
    return edit(`Расписание после отмены:\n\n${await renderDay(db,day)}`,days(now,'show'));
  }
  if (command.startsWith('/')) {
    // Every new command exits the previous admin input dialog.
    const operations = [['DELETE FROM states WHERE user_id=? AND $GUARD',[uid]]];
    if (admin && ['/add','/remove'].includes(command)) operations.push([
      'INSERT INTO states(user_id,action,expires) SELECT ?,?,? WHERE $GUARD ON CONFLICT(user_id) DO UPDATE SET action=excluded.action,expires=excluded.expires',
      [uid,command.slice(1),Date.now()+15*60000]
    ]);
    await mutate(db,update.update_id,operations);
    if (command === '/today') return send(await renderDay(db,now.day));
    if (command === '/week') return send('Выбери день:',days(now,'show'));
    if (command === '/book') return send('Выбери день для брони:',days(now,'bookday'));
    if (command === '/cancel') return send('Выбери день для отмены:',days(now,'cancelday'));
    if (['/add','/remove','/list'].includes(command)) {
      if (!admin) return send('Нет прав.');
      if (command !== '/list') return send('Пришли Telegram user_id человека (число). Диалог действует 15 минут. /abort — выйти.');
      const all = await rows(db,'SELECT user_id,name FROM users WHERE participant=1 ORDER BY user_id');
      const lines = [`👑 Админ: id${env.ADMIN_USER_ID}`,...all.map(u => `• ${u.name || 'Без имени'} (id${u.user_id})`)];
      // Telegram messages are limited to 4096 characters.
      let chunk = '';
      for (const line of lines) { if ((chunk+line).length > 3500) {await send(chunk); chunk='';} chunk += line+'\n'; }
      return send(chunk);
    }
    if (command === '/abort') return send('Ввод отменён.');
    return send('⚡ Бронирование зарядных мест\n\n/week — расписание на неделю\n/book — забронировать\n/cancel — отменить свою бронь\n/today — расписание сегодня\n/id — мой ID\n\nТвой ID: '+uid+(admin ? '\n\n👑 /add — добавить участника\n/remove — убрать участника\n/list — участники\n/abort — отменить ввод' : ''));
  }
  const state = admin && await first(db,'SELECT action FROM states WHERE user_id=? AND expires>?',[uid,Date.now()]);
  if (!state) return send('Открой /start для списка команд.');
  const text = (message.text || '').trim();
  const target = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(target)) return send('Нужен положительный числовой Telegram user_id. /abort — выйти.');
  if (target === Number(env.ADMIN_USER_ID)) return send('Администратор уже имеет доступ; удалить его этой командой нельзя.');
  await mutate(db, update.update_id,[
    ['INSERT INTO users(user_id,participant) SELECT ?,? WHERE $GUARD ON CONFLICT(user_id) DO UPDATE SET participant=excluded.participant',[target,state.action === 'add' ? 1 : 0]],
    ['DELETE FROM states WHERE user_id=? AND $GUARD',[uid]]
  ]);
  return send(state.action === 'add' ? `Добавил участника id${target}.` : `Убрал участника id${target}. Его существующие брони сохранены до конца соответствующих дат.`);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/') return new Response('Charging bot is running.');
    if (path !== '/webhook') return new Response('Not found',{status:404});
    if (request.method !== 'POST') return new Response('Method not allowed',{status:405});
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !env.DB || !/^[1-9]\d*$/.test(env.ADMIN_USER_ID || '')) return new Response('Not configured',{status:503});
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('Forbidden',{status:403});
    let update;
    try {update = await request.json();} catch {return new Response('Invalid JSON',{status:400});}
    try {
      await handleUpdate(update,env);
      return new Response('OK');
    } catch {
      // Never log token-bearing URLs or personal message bodies.
      console.error('Webhook processing failed',update?.update_id);
      return new Response('Retry later',{status:500});
    }
  }
};
