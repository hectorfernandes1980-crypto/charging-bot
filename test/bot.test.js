import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker, {handleUpdate, localNow, validSlot} from '../src/worker.js';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));
  const DB = {
    prepare(query) { return {bind(...args) {return {
      first: async () => sql.prepare(query).get(...args) || null,
      all: async () => ({results:sql.prepare(query).all(...args)}),
      run: async () => ({meta:sql.prepare(query).run(...args)})
    };}};},
    async batch(statements) {
      sql.exec('BEGIN');
      try { const r=[]; for (const s of statements) r.push(await s.run()); sql.exec('COMMIT'); return r; }
      catch(e) {sql.exec('ROLLBACK'); throw e;}
    }
  };
  const sent=[];
  globalThis.fetch = async (url,opts) => { sent.push({method:url.split('/').at(-1),...JSON.parse(opts.body)}); return Response.json({ok:true,result:{}}); };
  const env={DB,ADMIN_USER_ID:'1',TIME_ZONE:'Europe/Moscow',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'};
  let id=0;
  const msg=(uid,text) => ({update_id:++id,message:{message_id:id,from:{id:uid,first_name:'User'+uid},chat:{id:uid,type:'private'},text}});
  const cb=(uid,data) => ({update_id:++id,callback_query:{id:String(id),from:{id:uid,first_name:'User'+uid},data,message:{message_id:10,chat:{id:uid,type:'private'}}}});
  const now={day:'2026-11-09',minutes:600};
  const run=u=>handleUpdate(u,env,now);
  return {sql,env,msg,cb,run,sent};
}

test('Moscow midnight, week window and elapsed slots',()=>{
  assert.deepEqual(localNow(new Date('2026-11-08T21:05:00Z')),{day:'2026-11-09',minutes:5});
  const n={day:'2026-11-09',minutes:840};
  assert.equal(validSlot('2026-11-09',1,0,n),false);
  assert.equal(validSlot('2026-11-09',1,1,n),true);
  assert.equal(validSlot('2026-11-16',1,1,n),false);
  assert.equal(validSlot('2026-11-08',1,1,n),false);
});
test('admin add, booking conflict, ownership, cancel and replay',async()=>{
  const f=fixture();
  await f.run(f.msg(1,'/add')); await f.run(f.msg(1,'2'));
  await f.run(f.msg(1,'/add')); await f.run(f.msg(1,'3'));
  const booking=f.cb(2,'book|2026-11-09|1|0');
  await f.run(booking);
  await f.run(f.cb(3,'book|2026-11-09|1|0'));
  assert.match(f.sent.at(-1).text,/занят/);
  await f.run(f.cb(3,'cancel|2026-11-09|1|0'));
  assert.equal(f.sql.prepare('SELECT user_id FROM bookings').get().user_id,2);
  await f.run(f.cb(2,'cancel|2026-11-09|1|0'));
  await f.run(booking); // retry must not restore the cancelled booking
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM bookings').get().n,0);
});
test('removed members, malformed/stale callbacks, non-text admin input',async()=>{
  const f=fixture();
  await f.run(f.msg(1,'/add')); await f.run(f.msg(1,undefined));
  assert.match(f.sent.at(-1).text,/числовой/);
  await f.run(f.msg(1,'2'));
  await f.run(f.msg(1,'/remove')); await f.run(f.msg(1,'2'));
  await f.run(f.cb(2,'book|2026-11-10|1|0'));
  assert.match(f.sent.at(-1).text,/не в списке/);
  await f.run(f.cb(1,'book|2026-11-08|1|0'));
  assert.match(f.sent.at(-1).text,/устарела/);
  await f.run(f.cb(1,'book|2026-11-10|1|'));
  assert.match(f.sent.at(-1).text,/Неизвестная/);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM bookings').get().n,0);
});
test('state survives fresh handlers, /abort exits, back button preserves action',async()=>{
  const f=fixture();
  await f.run(f.msg(1,'/add'));
  await f.run(f.msg(1,'/abort'));
  await f.run(f.msg(1,'2'));
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM users WHERE participant=1').get().n,0);
  await f.run(f.cb(1,'canceldays|'));
  assert.equal(f.sent.at(-2).reply_markup.inline_keyboard[0][0].callback_data,'cancelday|2026-11-09');
});
test('database uniqueness independently prevents double booking',()=>{
  const f=fixture();
  f.sql.exec("INSERT INTO bookings VALUES ('2026-11-10',1,0,2)");
  assert.throws(()=>f.sql.exec("INSERT INTO bookings VALUES ('2026-11-10',1,0,3)"));
});
test('webhook authentication and route validation',async()=>{
  const f=fixture();
  assert.equal((await worker.fetch(new Request('https://test/webhook',{method:'POST',body:'{}'}),f.env)).status,403);
  assert.equal((await worker.fetch(new Request('https://test/webhook'),f.env)).status,405);
  assert.equal((await worker.fetch(new Request('https://test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'secret'},body:'not json'}),f.env)).status,400);
  assert.equal((await worker.fetch(new Request('https://test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'secret'},body:'{"update_id":10}'}),f.env)).status,200);
});
