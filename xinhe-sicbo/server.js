// 鑫禾骰寶 伺服器：帳號登入、統一開骰、保存籌碼、用 WebSocket 即時同步所有玩家
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const ROUND = 30000, BET_MS = 22000, START = 10000, HIST = 16, CHIPS = [10, 100, 500, 1000, 5000, 10000], MAX_BET = 100000;
const DATA = path.join(__dirname, "data.json");
const COLORS = ["#ff5252","#40c4ff","#69f0ae","#ffd740","#e040fb","#ff9100","#18ffff","#b2ff59","#ff80ab","#7c4dff","#ffab40","#64ffda"];
const TOTAL_ODDS = {4:50,5:18,6:14,7:12,8:8,9:6,10:6,11:6,12:6,13:8,14:12,15:14,16:18,17:50};

const KEYS = new Set(["big","small","odd","even","anytri"]);
for (let d = 1; d <= 6; d++) { KEYS.add("d"+d); KEYS.add("tr"+d); KEYS.add("n"+d); }
for (let t = 4; t <= 17; t++) KEYS.add("t"+t);
for (let a = 1; a <= 6; a++) for (let b = a+1; b <= 6; b++) KEYS.add("c"+a+b);

function payout(k, amt, d) { // 回傳含本金的派彩，輸則 0
  const s = d[0]+d[1]+d[2], tri = d[0]===d[1] && d[1]===d[2], cnt = v => d.filter(x => x===v).length;
  if (k==="big") return (!tri && s>=11) ? amt*2 : 0;
  if (k==="small") return (!tri && s<=10) ? amt*2 : 0;
  if (k==="odd") return (!tri && s%2) ? amt*2 : 0;
  if (k==="even") return (!tri && s%2===0) ? amt*2 : 0;
  if (k==="anytri") return tri ? amt*25 : 0;
  if (k.startsWith("tr")) return cnt(+k[2])===3 ? amt*151 : 0;
  if (k[0]==="d") return cnt(+k[1])>=2 ? amt*11 : 0;
  if (k[0]==="c") return (cnt(+k[1]) && cnt(+k[2])) ? amt*6 : 0;
  if (k[0]==="t") return s===+k.slice(1) ? amt*(TOTAL_ODDS[s]+1) : 0;
  if (k[0]==="n") { const c = cnt(+k.slice(1)); return c ? amt*(c+1) : 0; }
  return 0;
}

// ---- 帳號與儲存 ----
// 有設定 DATABASE_URL 時存到 PostgreSQL（重開機、重新部署都保留）；否則存在 data.json。
let accounts = new Map(); // 暱稱(小寫) -> {id,name,salt,hash,balance,color,token,bets,round,lastSeen}
let hist = [];
const dirty = new Set();
let pool = null;
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
const keyOf = n => n.toLowerCase();

async function loadStore() {
  let rows = [];
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });
    await pool.query("CREATE TABLE IF NOT EXISTS sicbo_accounts (k TEXT PRIMARY KEY, data JSONB NOT NULL)");
    await pool.query("CREATE TABLE IF NOT EXISTS sicbo_meta (k TEXT PRIMARY KEY, data JSONB NOT NULL)");
    rows = (await pool.query("SELECT data FROM sicbo_accounts")).rows.map(r => r.data);
    const h = await pool.query("SELECT data FROM sicbo_meta WHERE k='hist'");
    if (h.rows[0]) hist = h.rows[0].data;
    console.log("儲存：PostgreSQL");
  } else {
    try { const j = JSON.parse(fs.readFileSync(DATA, "utf8")); rows = j.accounts || []; hist = j.hist || []; } catch {}
    console.log("儲存：data.json（伺服器重新部署後會清空）");
  }
  for (const a of rows) {
    // 伺服器中斷時尚未開骰的下注全數退還
    for (const v of Object.values(a.bets || {})) a.balance += v;
    a.bets = {}; a.round = 0; a.sessionStart = null;
    accounts.set(keyOf(a.name), a);
  }
}
async function flush() {
  if (!dirty.size && !flush.hist) return;
  const list = [...dirty].map(k => accounts.get(k)).filter(Boolean); dirty.clear();
  const pub = a => ({ id: a.id, name: a.name, salt: a.salt, hash: a.hash, balance: a.balance, color: a.color, token: a.token, rounds: a.rounds || 0, net: a.net || 0, onlineMs: a.onlineMs || 0, refills: a.refills || 0, bets: a.round === round && a.settled !== round ? a.bets : {}, lastSeen: a.lastSeen });
  try {
    if (pool) {
      for (const a of list) await pool.query("INSERT INTO sicbo_accounts (k,data) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET data=EXCLUDED.data", [keyOf(a.name), pub(a)]);
      if (flush.hist) await pool.query("INSERT INTO sicbo_meta (k,data) VALUES ('hist',$1) ON CONFLICT (k) DO UPDATE SET data=EXCLUDED.data", [JSON.stringify(hist)]);
    } else {
      fs.writeFileSync(DATA, JSON.stringify({ accounts: [...accounts.values()].map(pub), hist }));
    }
    flush.hist = false;
  } catch (e) { console.error("儲存失敗", e.message); for (const a of list) dirty.add(keyOf(a.name)); }
}
const touch = a => dirty.add(keyOf(a.name));
setInterval(flush, 3000);

// ---- 網頁 ----
// 頁面：/ 鑫河大廳、/sicbo 骰寶、/poker 德州撲克
const PAGES = { "/": "lobby.html", "/sicbo": "index.html", "/poker": "poker.html", "/mahjong": "mahjong.html" };
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0].replace(/\/+$/, "") || "/";
  if (url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  const page = PAGES[url];
  if (page) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return fs.createReadStream(path.join(__dirname, "public", page)).pipe(res);
  }
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }); res.end('找不到這個頁面。<a href="/">回鑫河大廳</a>');
});

// ---- 遊戲 ----
const wss = new WebSocketServer({ server });
let round = 0, start = 0, dice = null, revealed = false;
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const broadcast = m => { const s = JSON.stringify(m); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };
const staked = p => p.round === round ? Object.values(p.bets).reduce((a, b) => a + b, 0) : 0;
const meMsg = p => ({ type: "me", id: p.id, name: p.name, color: p.color, balance: p.balance, bets: p.round === round ? p.bets : {}, round });
function pickColor() {
  const used = {}; for (const c of wss.clients) if (c.player) used[c.player.color] = (used[c.player.color] || 0) + 1;
  return COLORS.slice().sort((a, b) => (used[a] || 0) - (used[b] || 0))[0];
}
function playersMsg() {
  const online = new Set([...wss.clients].map(c => c.player && c.player.id).filter(Boolean));
  const list = [...accounts.values()]
    .filter(p => online.has(p.id))
    .map(p => ({ id: p.id, name: p.name, color: p.color, balance: p.balance, staked: staked(p), bets: p.round === round ? p.bets : {}, online: online.has(p.id) }))
    .sort((a, b) => (b.online - a.online) || (b.balance - a.balance)).slice(0, 20);
  return { type: "players", list, online: online.size };
}
let pTimer = null;
function pushPlayers() { if (pTimer) return; pTimer = setTimeout(() => { pTimer = null; broadcast(playersMsg()); }, 150); }
const stateMsg = () => ({ type: "state", round, start, now: Date.now(), ROUND, BET_MS, hist, dice: revealed ? dice : null });

function newRound() {
  round++; start = Date.now(); revealed = false;
  dice = [0, 0, 0].map(() => crypto.randomInt(1, 7)); // 開骰前只存在伺服器
  broadcast(stateMsg());
  for (const c of wss.clients) if (c.player) send(c, meMsg(c.player));
  pushPlayers();
}
function reveal() {
  revealed = true;
  hist.unshift({ round, dice }); hist = hist.slice(0, HIST); flush.hist = true;
  broadcast({ type: "roll", round, dice, hist });
  for (const p of accounts.values()) {
    if (p.round !== round || !Object.keys(p.bets).length) continue;
    let back = 0, st = 0;
    for (const [k, a] of Object.entries(p.bets)) { st += a; back += payout(k, a, dice); }
    p.balance += back; p.lastNet = back - st; p.settled = round;
    p.rounds = (p.rounds || 0) + 1; p.net = (p.net || 0) + back - st; touch(p);
  }
  setTimeout(() => {
    for (const c of wss.clients) { const p = c.player; if (p && p.settled === round) send(c, { type: "settle", round, net: p.lastNet, balance: p.balance }); }
    pushPlayers();
  }, 2700);
}

// 上線時間：登入時開始計時，離線、登出或被擠下線時累加
function endSession(a) { if (a && a.sessionStart) { a.onlineMs = (a.onlineMs || 0) + Date.now() - a.sessionStart; a.sessionStart = null; touch(a); } }
const stillOnline = (a, except) => [...wss.clients].some(c => c !== except && c.player === a);
setInterval(() => { for (const a of accounts.values()) if (a.sessionStart) { endSession(a); a.sessionStart = Date.now(); } }, 60000);
function statsMsg() {
  const online = new Set([...wss.clients].map(c => c.player && c.player.id).filter(Boolean));
  const list = [...accounts.values()].map(a => ({ name: a.name, color: a.color, rounds: a.rounds || 0, net: a.net || 0,
    onlineMs: (a.onlineMs || 0) + (a.sessionStart ? Date.now() - a.sessionStart : 0), refills: a.refills || 0, balance: a.balance, online: online.has(a.id) }))
    .sort((x, y) => y.net - x.net);
  return { type: "stats", list };
}

function signIn(ws, a) {
  for (const c of wss.clients) if (c !== ws && c.player === a) { send(c, { type: "kicked" }); c.player = null; }
  if (!a.sessionStart) a.sessionStart = Date.now();
  const taken = [...wss.clients].some(c => c.player && c.player !== a && c.player.color === a.color);
  if (!a.color || taken) a.color = pickColor();
  a.lastSeen = Date.now(); touch(a); ws.player = a;
  send(ws, { type: "auth", ok: true, token: a.token, name: a.name }); send(ws, meMsg(a)); pushPlayers();
}
const chatLog = []; // 最近 50 則聊天訊息（只存在記憶體）
const fails = new Map(); // 防止暴力猜密碼：每個連線 5 次錯誤後暫停 30 秒

wss.on("connection", ws => {
  ws.isAlive = true; ws.on("pong", () => ws.isAlive = true);
  send(ws, stateMsg()); send(ws, playersMsg()); send(ws, { type: "chatlog", list: chatLog });
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const err = t => send(ws, { type: "error", text: t });
    const authErr = t => send(ws, { type: "auth", ok: false, text: t });
    if (m.type === "register" || m.type === "login") {
      const f = fails.get(ws) || { n: 0, until: 0 };
      if (Date.now() < f.until) return authErr("嘗試太多次，請 30 秒後再試");
      const name = String(m.name || "").replace(/\s+/g, " ").trim().slice(0, 12), pw = String(m.password || "");
      if (!name) return authErr("請輸入暱稱");
      if (pw.length < 4 || pw.length > 64) return authErr("密碼需要 4 到 64 個字元");
      let a = accounts.get(keyOf(name));
      if (m.type === "register") {
        if (a) return authErr("這個暱稱已經有人用了，請換一個，或改用「已有帳號」登入");
        const salt = crypto.randomBytes(16).toString("hex");
        a = { id: crypto.randomBytes(6).toString("hex"), name, salt, hash: hashPw(pw, salt), balance: START, color: null, token: crypto.randomBytes(24).toString("hex"), bets: {}, round: 0 };
        accounts.set(keyOf(name), a);
      } else {
        const ok = a && crypto.timingSafeEqual(Buffer.from(hashPw(pw, a.salt), "hex"), Buffer.from(a.hash, "hex"));
        if (!ok) { f.n++; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 30000; } fails.set(ws, f); return authErr("暱稱或密碼不正確"); }
        a.token = crypto.randomBytes(24).toString("hex"); // 新登入讓舊裝置的自動登入失效
      }
      return signIn(ws, a);
    }
    if (m.type === "resume") {
      const a = typeof m.token === "string" && m.token.length > 20 && [...accounts.values()].find(x => x.token === m.token);
      return a ? signIn(ws, a) : authErr("");
    }
    if (m.type === "logout") { if (ws.player) { const a = ws.player; ws.player = null; if (!stillOnline(a)) endSession(a); pushPlayers(); } return; }
    if (m.type === "stats") return send(ws, statsMsg());
    const p = ws.player; if (!p) return send(ws, { type: "auth", ok: false, text: "請先登入" });
    p.lastSeen = Date.now();
    const betting = !revealed && Date.now() < start + BET_MS;
    if (m.type === "bet") {
      if (!betting) return err("已停止下注");
      if (!KEYS.has(m.k)) return err("無效的下注");
      if (p.round !== round) { p.round = round; p.bets = {}; }
      let amt = m.amt;
      if (amt === "all") { // ALL IN：押上全部餘額（不超過每局上限）
        amt = Math.min(p.balance, MAX_BET - staked(p));
        if (p.balance <= 0) return err("籌碼不足");
        if (amt <= 0) return err("每局最多下注 100,000");
      } else if (!CHIPS.includes(amt)) return err("無效的下注");
      if (p.balance < amt) return err("籌碼不足");
      if (staked(p) + amt > MAX_BET) return err("每局最多下注 100,000");
      p.balance -= amt; p.bets[m.k] = (p.bets[m.k] || 0) + amt; touch(p);
      send(ws, meMsg(p)); pushPlayers();
    } else if (m.type === "clear") {
      if (!betting || p.round !== round) return;
      p.balance += staked(p); p.bets = {}; touch(p); send(ws, meMsg(p)); pushPlayers();
    } else if (m.type === "chat") {
      const text = String(m.text || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
      if (!text) return;
      if (Date.now() - (p.lastChat || 0) < 1000) return err("訊息發太快了，請稍等一下");
      p.lastChat = Date.now();
      const msg = { name: p.name, color: p.color, text, ts: Date.now() };
      chatLog.push(msg); if (chatLog.length > 50) chatLog.shift();
      broadcast({ type: "chat", ...msg });
    } else if (m.type === "refill") {
      if (p.balance >= 10 || staked(p)) return err("籌碼用完才能補充");
      p.balance = START; p.refills = (p.refills || 0) + 1; touch(p); send(ws, meMsg(p)); send(ws, { type: "info", text: "已補滿 10,000 籌碼" }); pushPlayers();
    }
  });
  ws.on("close", () => { fails.delete(ws); if (ws.player && !stillOnline(ws.player, ws)) endSession(ws.player); pushPlayers(); });
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 25000);

process.on("SIGTERM", async () => { for (const a of accounts.values()) endSession(a); await flush(); process.exit(0); });
loadStore().then(() => {
  setInterval(() => {
    const now = Date.now();
    if (!start || now >= start + ROUND) newRound();
    else if (!revealed && now >= start + BET_MS) reveal();
  }, 100);
  server.listen(PORT, () => console.log("鑫禾骰寶 running on port " + PORT));
}).catch(e => { console.error("無法載入資料", e); process.exit(1); });
