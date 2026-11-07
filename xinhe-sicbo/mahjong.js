// 鑫河麻將 連線牌桌：伺服器上一張四人桌，空位由電腦補；真人隨時入座取代電腦，離座後換回電腦。
// 輸贏用帳戶籌碼結算（底 300、每台 100）。
const crypto = require("crypto");

module.exports = function startMahjong(mjs, ctx) {
  const KEEP = 16, BASE = 300, PER = 100, THINK = 15000, BOT_MS = 700, GAP = 7000, GRACE = 20000, MIN_BAL = 1000;
  const NUM = ["一","二","三","四","五","六","七","八","九"], SU = ["萬","筒","條"], ZI = ["東","南","西","北","中","發","白"], FL = ["春","夏","秋","冬","梅","蘭","竹","菊"], WIND = ["東","南","西","北"];
  const BOTN = ["阿龍", "小美", "老K", "莎莎"];
  const tname = t => t < 27 ? NUM[t % 9] + SU[t / 9 | 0] : t < 34 ? ZI[t - 27] : FL[t - 34];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- 胡牌判斷 ----------
  const counts = a => { const c = Array(34).fill(0); a.forEach(t => c[t]++); return c; };
  function sets(c, mode) {
    const i = c.findIndex(x => x > 0); if (i < 0) return true;
    if (mode !== "c" && c[i] >= 3) { c[i] -= 3; const ok = sets(c, mode); c[i] += 3; if (ok) return true; }
    if (mode !== "p" && i < 27 && i % 9 <= 6 && c[i + 1] && c[i + 2]) { c[i]--; c[i + 1]--; c[i + 2]--; const ok = sets(c, mode); c[i]++; c[i + 1]++; c[i + 2]++; if (ok) return true; }
    return false;
  }
  function decomp(c, mode) { if (c.reduce((a, b) => a + b, 0) % 3 !== 2) return false; for (let i = 0; i < 34; i++) if (c[i] >= 2) { c[i] -= 2; const ok = sets(c, mode); c[i] += 2; if (ok) return true; } return false; }
  const isWin = c => decomp(c);

  // ---------- 狀態 ----------
  const seats = BOTN.map(n => ({ bot: true, name: n, botName: n, hand: [], melds: [], flowers: [], discards: [] }));
  let dealer = 0, roundWind = 0, passes = 0, running = false, wall = [], turn = -1, last = null, msg = "", result = null, handNo = 0, promptSeq = 0;
  const seatWind = i => (i - dealer + 4) % 4;
  const live = s => !s.bot && s.ws && s.ws.readyState === 1;
  const humans = () => seats.filter(s => !s.bot).length;
  const say = t => { msg = t; push(); };
  function newWall() { const w = []; for (let t = 0; t < 34; t++) for (let k = 0; k < 4; k++) w.push(t); for (let f = 34; f < 42; f++) w.push(f);
    for (let i = w.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [w[i], w[j]] = [w[j], w[i]]; } return w; }
  function draw(p, tail) { let t = tail ? wall.pop() : wall.shift(); while (t >= 34) { p.flowers.push(t); say(p.name + " 補花 " + tname(t)); t = wall.pop(); } p.hand.push(t); return t; }
  function removeN(arr, t, n) { for (let k = 0; k < n; k++) { const i = arr.indexOf(t); if (i >= 0) arr.splice(i, 1); } }

  // ---------- 電腦 ----------
  function botDiscard(i) {
    const p = seats[i], c = counts(p.hand); let best = p.hand[0], bv = 1e9;
    for (const t of new Set(p.hand)) {
      let v = c[t] * 4;
      if (t < 27) { const n = t % 9, g = d => (n + d >= 0 && n + d <= 8) ? c[t + d] : 0; v += (g(-1) + g(1)) * 3 + (g(-2) + g(2)) * 1.5; if (n === 0 || n === 8) v -= .6; }
      else if (t >= 31 || t - 27 === roundWind || t - 27 === seatWind(i)) v += .8;
      v += Math.random() * .3; if (v < bv) { bv = v; best = t; }
    }
    return best;
  }
  function botClaim(i, t, opts) {
    const w = opts.find(o => o.type === "win"); if (w) return w;
    const k = opts.find(o => o.type === "kong"); if (k && Math.random() < .6) return k;
    const p = opts.find(o => o.type === "pong"); if (p && (t >= 27 || Math.random() < .45)) return p;
    const ch = opts.filter(o => o.type === "chi"); if (ch.length && Math.random() < .3) return ch[0];
    return null;
  }

  // ---------- 等真人決定（逾時或斷線就用預設）----------
  function ask(i, pr, def, check) {
    return new Promise(res => {
      const s = seats[i], id = ++promptSeq;
      const P0 = { id, pr, deadline: Date.now() + THINK, check, def, fin: null };
      const tm = setTimeout(() => P0.fin(def), THINK + 1000);
      P0.fin = v => { if (s.pending !== P0) return; clearTimeout(tm); s.pending = null; push(); res(v); };
      s.pending = P0; push();
    });
  }
  const cancelPending = s => { if (s.pending) s.pending.fin(s.pending.def); };

  async function selfTurn(i, drawn, didDraw, kongDraw) {
    const p = seats[i], c = counts(p.hand), canZimo = didDraw && isWin(c), kongs = [];
    if (didDraw && wall.length > KEEP) {
      for (let t = 0; t < 34; t++) if (c[t] === 4) kongs.push({ t, an: true });
      p.melds.forEach(m => { if (m.k === "pong" && c[m.t[0]]) kongs.push({ t: m.t[0], add: true }); });
    }
    let r;
    if (!live(p)) {
      await sleep(BOT_MS);
      r = canZimo ? { type: "win" } : kongs.length && Math.random() < .8 ? { type: "kong", ...kongs[0] } : { type: "discard", tile: botDiscard(i) };
    } else {
      const auto = canZimo ? { type: "win" } : { type: "discard", tile: didDraw && drawn != null ? drawn : p.hand.slice().sort((a, b) => a - b).pop() };
      r = await ask(i, { kind: "self", drawn: didDraw ? drawn : null, canZimo, kongs }, auto, v => {
        if (!v || typeof v !== "object") return;
        if (v.type === "discard" && p.hand.includes(v.tile)) return { type: "discard", tile: v.tile };
        if (v.type === "win" && canZimo) return { type: "win" };
        if (v.type === "kong") { const k = kongs.find(k => k.t === v.t); if (k) return { type: "kong", ...k }; }
      });
      if (r.type === "discard" && !p.hand.includes(r.tile)) r = { type: "discard", tile: p.hand[p.hand.length - 1] };
    }
    if (r.type === "kong") {
      if (r.an) { removeN(p.hand, r.t, 4); p.melds.push({ k: "ankong", t: [r.t, r.t, r.t, r.t] }); say(p.name + " 暗槓"); }
      else { removeN(p.hand, r.t, 1); const m = p.melds.find(m => m.k === "pong" && m.t[0] === r.t); m.k = "kong"; m.t.push(r.t); say(p.name + " 加槓 " + tname(r.t)); }
    }
    r.kongDraw = kongDraw; return r;
  }

  async function claims(from, t) {
    const dec = [];
    for (let k = 1; k < 4; k++) {
      const i = (from + k) % 4, c = counts(seats[i].hand), o = [];
      c[t]++; if (isWin(c)) o.push({ type: "win" }); c[t]--;
      if (wall.length > KEEP) {
        if (c[t] >= 2) o.push({ type: "pong" }); if (c[t] === 3) o.push({ type: "kong" });
        if (k === 1 && t < 27) { const n = t % 9; [[-2, -1], [-1, 1], [1, 2]].forEach(([a, b]) => { if (n + a >= 0 && n + b <= 8 && c[t + a] && c[t + b]) o.push({ type: "chi", use: [t + a, t + b] }); }); }
      }
      if (!o.length) continue;
      let d;
      if (!live(seats[i])) d = botClaim(i, t, o);
      else d = await ask(i, { kind: "claim", tile: t, from, options: o }, null, v => { if (v === null) return null; const s = JSON.stringify(v); return o.find(x => JSON.stringify(x) === s); });
      if (d) dec.push({ ...d, p: i, order: k });
    }
    const pr = { win: 3, kong: 2, pong: 2, chi: 1 };
    dec.sort((a, b) => pr[b.type] - pr[a.type] || a.order - b.order);
    return dec[0] || null;
  }

  // ---------- 一局 ----------
  async function playHand() {
    running = true; result = null; handNo++; last = null; wall = newWall();
    seats.forEach(s => { s.hand = []; s.melds = []; s.flowers = []; s.discards = []; });
    for (let r = 0; r < 16; r++) for (let k = 0; k < 4; k++) seats[(dealer + k) % 4].hand.push(wall.shift());
    for (let k = 0; k < 4; k++) { const p = seats[(dealer + k) % 4]; let j; while ((j = p.hand.findIndex(t => t >= 34)) >= 0) { p.flowers.push(p.hand.splice(j, 1)[0]); p.hand.push(wall.pop()); } }
    say(`第 ${handNo} 局開始，莊家 ${seats[dealer].name}`);
    let cur = dealer, mode = "draw", kongDraw = false;
    while (true) {
      turn = cur; let drawn = null;
      if (mode === "draw") { if (wall.length <= KEEP) return finish(null); drawn = draw(seats[cur], kongDraw); }
      push();
      const r = await selfTurn(cur, drawn, mode === "draw", kongDraw); kongDraw = false;
      if (r.type === "win") return finish({ w: cur, from: -1, t: drawn, kongDraw: r.kongDraw });
      if (r.type === "kong") { mode = "draw"; kongDraw = true; continue; }
      const t = r.tile, p = seats[cur]; removeN(p.hand, t, 1); p.discards.push(t); last = { p: cur, t }; say(`${p.name} 打出 ${tname(t)}`);
      await sleep(350);
      const c = await claims(cur, t);
      if (c) {
        if (c.type === "win") { p.discards.pop(); last = null; return finish({ w: c.p, from: cur, t }); }
        p.discards.pop(); last = null; const q = seats[c.p];
        if (c.type === "pong") { removeN(q.hand, t, 2); q.melds.push({ k: "pong", t: [t, t, t] }); say(q.name + " 碰 " + tname(t)); mode = "claim"; }
        else if (c.type === "kong") { removeN(q.hand, t, 3); q.melds.push({ k: "kong", t: [t, t, t, t] }); say(q.name + " 槓 " + tname(t)); mode = "draw"; kongDraw = true; }
        else { removeN(q.hand, c.use[0], 1); removeN(q.hand, c.use[1], 1); q.melds.push({ k: "chi", t: [c.use[0], t, c.use[1]].sort((a, b) => a - b) }); say(q.name + " 吃 " + tname(t)); mode = "claim"; }
        cur = c.p; await sleep(300); continue;
      }
      cur = (cur + 1) % 4; mode = "draw";
    }
  }

  function scoreHand(i, t, zimo, kongDraw) {
    const p = seats[i], full = p.hand.slice(); if (!zimo) full.push(t);
    const c = counts(full), L = [], add = (n, v) => L.push([n, v]);
    const open = p.melds.filter(m => m.k !== "ankong"), menq = !open.length, sw = seatWind(i);
    if (i === dealer) add("莊家", 1);
    if (menq && zimo) add("門清自摸", 3); else { if (menq) add("門清", 1); if (zimo) add("自摸", 1); }
    const fs = p.flowers;
    if ([34, 35, 36, 37].every(f => fs.includes(f))) add("春夏秋冬", 2); else if (fs.includes(34 + sw)) add("正花 " + FL[sw], 1);
    if ([38, 39, 40, 41].every(f => fs.includes(f))) add("梅蘭竹菊", 2); else if (fs.includes(38 + sw)) add("正花 " + FL[4 + sw], 1);
    const mp = Array(34).fill(false); p.melds.forEach(m => { if (m.k !== "chi") mp[m.t[0]] = true; });
    const pung = h => mp[h] || c[h] >= 3, pair = h => c[h] === 2;
    const dr = [31, 32, 33].filter(pung).length;
    if (dr === 3) add("大三元", 8); else if (dr === 2 && [31, 32, 33].some(pair)) add("小三元", 4); else [31, 32, 33].forEach(h => { if (pung(h)) add(ZI[h - 27] + "刻", 1); });
    const wd = [27, 28, 29, 30].filter(pung).length;
    if (wd === 4) add("大四喜", 16); else if (wd === 3 && [27, 28, 29, 30].some(pair)) add("小四喜", 8);
    else { if (pung(27 + roundWind)) add("圈風 " + WIND[roundWind], 1); if (pung(27 + sw)) add("門風 " + WIND[sw], 1); }
    const all = full.concat(...p.melds.map(m => m.t)), suits = new Set(all.filter(x => x < 27).map(x => x / 9 | 0)), hasZ = all.some(x => x >= 27);
    if (!suits.size) add("字一色", 16); else if (suits.size === 1) hasZ ? add("混一色", 4) : add("清一色", 8);
    if (p.melds.every(m => m.k !== "chi") && decomp(c.slice(), "p")) add("碰碰胡", 4);
    if (!zimo && !fs.length && !hasZ && p.melds.every(m => m.k === "chi") && decomp(c.slice(), "c")) add("平胡", 2);
    if (!zimo && open.length === 5) add("全求人", 2);
    if (kongDraw) add("槓上開花", 1);
    if (wall.length <= KEEP) add(zimo ? "海底撈月" : "河底撈魚", 1);
    return L;
  }

  function finish(res) {
    turn = -1;
    if (!res) { result = { id: handNo, draw: true, next: Date.now() + GAP }; say("流局，莊家連莊"); }
    else {
      const { w, from, t, kongDraw } = res, zimo = from < 0, L = scoreHand(w, t, zimo, kongDraw), tai = L.reduce((a, x) => a + x[1], 0), pays = [];
      let gained = 0;
      (zimo ? [1, 2, 3].map(k => (w + k) % 4) : [from]).forEach(j => {
        const extra = (j === dealer && w !== dealer) ? 1 : 0, amt = BASE + PER * (tai + extra), s = seats[j];
        let paid = amt;
        if (!s.bot) { paid = Math.max(0, Math.min(amt, s.acct.balance)); s.acct.balance -= paid; s.acct.mjNet = (s.acct.mjNet || 0) - paid; ctx.touch(s.acct); }
        gained += paid; pays.push(`${s.name} 付 ${paid.toLocaleString()}${extra ? "（含莊家 1 台）" : ""}`);
      });
      const W = seats[w];
      if (!W.bot) { W.acct.balance += gained; W.acct.mjNet = (W.acct.mjNet || 0) + gained; ctx.touch(W.acct); }
      const hand = W.hand.slice(); if (zimo) hand.splice(hand.indexOf(t), 1); hand.sort((a, b) => a - b);
      result = { id: handNo, w, name: W.name, zimo, tai, list: L, hand, t, melds: W.melds, flowers: W.flowers, from: zimo ? null : seats[from].name, pays, next: Date.now() + GAP };
      say(`${W.name} ${zimo ? "自摸" : "胡牌"} ${tai} 台`);
      if (w !== dealer) { dealer = (dealer + 1) % 4; passes++; if (passes % 4 === 0) roundWind = (roundWind + 1) % 4; }
    }
    push();
    setTimeout(nextHand, GAP);
  }
  function nextHand() {
    if (!humans()) { running = false; result = null; turn = -1; seats.forEach(s => { s.hand = []; s.melds = []; s.flowers = []; s.discards = []; }); wall = []; say("等待玩家入座…"); return; }
    playHand().catch(e => { console.error("麻將出錯", e); running = false; setTimeout(nextHand, GAP); });
  }

  // ---------- 入座／離座 ----------
  function toBot(s) {
    cancelPending(s); clearTimeout(s.leaveT);
    const name = s.name; s.bot = true; s.acct = null; s.ws = null; s.name = s.botName;
    say(`${name} 離座，電腦 ${s.botName} 接手`);
  }

  // ---------- 傳給每位玩家 ----------
  const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  function viewFor(ws) {
    const me = ws.acct, my = me ? seats.findIndex(s => !s.bot && s.acct === me) : -1, P0 = my >= 0 ? seats[my].pending : null;
    return {
      type: "mj_state", now: Date.now(), my, dealer, roundWind, wallLeft: Math.max(0, wall.length - KEEP), turn, last, msg, running, result,
      seats: seats.map((s, i) => ({ name: s.name, bot: s.bot, away: !s.bot && !live(s), bal: s.bot ? null : s.acct.balance, flowers: s.flowers, melds: s.melds, discards: s.discards, n: s.hand.length, hand: i === my ? s.hand : null })),
      prompt: P0 ? { id: P0.id, deadline: P0.deadline, ...P0.pr } : null,
      you: me ? { name: me.name, balance: me.balance, seated: my >= 0 } : null
    };
  }
  let pushT = null;
  function push() { if (pushT) return; pushT = setTimeout(() => { pushT = null; for (const c of mjs.clients) send(c, viewFor(c)); }, 30); }

  mjs.on("connection", ws => {
    ws.isAlive = true; ws.on("pong", () => ws.isAlive = true);
    send(ws, viewFor(ws));
    ws.on("message", raw => {
      if (raw.length > 4096) return;
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "mj_auth") {
        const r = ctx.auth(m, ws);
        if (r.err !== undefined) return send(ws, { type: "mj_auth", ok: false, text: r.err });
        ws.acct = r.acct;
        const s = seats.find(x => !x.bot && x.acct === r.acct);
        if (s) { if (s.ws && s.ws !== ws) send(s.ws, { type: "mj_info", text: "你的帳號在其他地方開啟了牌桌" }); s.ws = ws; clearTimeout(s.leaveT); }
        send(ws, { type: "mj_auth", ok: true, token: r.acct.token, name: r.acct.name }); return push();
      }
      const a = ws.acct; if (!a) return send(ws, { type: "mj_auth", ok: false, text: "請先登入" });
      const mine = seats.find(x => !x.bot && x.acct === a);
      if (m.type === "sit") {
        if (mine) return;
        if (a.balance < MIN_BAL) return send(ws, { type: "mj_info", text: `帳戶籌碼要有 ${MIN_BAL.toLocaleString()} 以上才能入座，可以先到骰寶領取` });
        const s = seats.find(x => x.bot); if (!s) return send(ws, { type: "mj_info", text: "牌桌已滿（4 位真人）" });
        const bn = s.name; cancelPending(s); s.bot = false; s.acct = a; s.ws = ws; s.name = a.name;
        say(`${a.name} 入座，取代電腦 ${bn}`);
        if (!running) { running = true; setTimeout(nextHand, 600); }
      } else if (m.type === "leave") {
        if (mine) toBot(mine);
      } else if (m.type === "mj_act") {
        if (!mine || !mine.pending || mine.pending.id !== m.id) return;
        const v = mine.pending.check(m.v); if (v !== undefined) mine.pending.fin(v);
      }
    });
    ws.on("close", () => {
      const a = ws.acct; if (!a) return;
      const s = seats.find(x => !x.bot && x.acct === a);
      if (s && s.ws === ws) { s.ws = null; cancelPending(s); push(); s.leaveT = setTimeout(() => { if (!s.bot && s.acct === a && !live(s)) toBot(s); }, GRACE); }
    });
  });
  setInterval(() => { for (const ws of mjs.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 25000);
  ctx.onShutdown && ctx.onShutdown(() => {});
  say("等待玩家入座…");
};
