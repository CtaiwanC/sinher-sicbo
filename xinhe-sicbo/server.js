// 鑫禾骰寶 伺服器：統一開骰、記錄籌碼、用 WebSocket 即時同步所有玩家
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const ROUND = 30000, BET_MS = 22000, START = 10000, HIST = 16, CHIPS = [10, 100, 500, 1000], MAX_BET = 100000;
const DATA = path.join(__dirname, "data.json");
const TOTAL_ODDS = {4:50,5:18,6:14,7:12,8:8,9:6,10:6,11:6,12:6,13:8,14:12,15:14,16:18,17:50};

// 合法下注項目
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

// ---- 狀態 ----
let players = new Map(); // token -> {id,name,balance,bets,round,lastSeen}
let hist = [];           // [{round,dice}] 新到舊
let round = 0, start = 0, dice = null, revealed = false;
try {
  const j = JSON.parse(fs.readFileSync(DATA, "utf8"));
  players = new Map(Object.entries(j.players || {})); hist = j.hist || []; round = j.round || 0;
  for (const p of players.values()) { p.bets = {}; }
} catch {}
function persist() {
  try { fs.writeFileSync(DATA, JSON.stringify({ players: Object.fromEntries(players), hist, round })); } catch {}
}
setInterval(persist, 30000);

// ---- 網頁 ----
const INDEX = path.join(__dirname, "public", "index.html");
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/" || req.url.startsWith("/?")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return fs.createReadStream(INDEX).pipe(res);
  }
  res.writeHead(404); res.end("not found");
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server });
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const broadcast = m => { const s = JSON.stringify(m); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };
const staked = p => p.round === round ? Object.values(p.bets).reduce((a, b) => a + b, 0) : 0;
const meMsg = p => ({ type: "me", id: p.id, name: p.name, balance: p.balance, bets: p.round === round ? p.bets : {}, round });

function playersMsg() {
  const online = new Set([...wss.clients].map(c => c.player && c.player.id).filter(Boolean));
  const list = [...players.values()]
    .filter(p => online.has(p.id) || Date.now() - p.lastSeen < 864e5)
    .map(p => ({ id: p.id, name: p.name, balance: p.balance, staked: staked(p), online: online.has(p.id) }))
    .sort((a, b) => (b.online - a.online) || (b.balance - a.balance)).slice(0, 20);
  return { type: "players", list, online: online.size };
}
let pTimer = null;
function pushPlayers() { if (pTimer) return; pTimer = setTimeout(() => { pTimer = null; broadcast(playersMsg()); }, 150); }

function stateMsg() { return { type: "state", round, start, now: Date.now(), ROUND, BET_MS, hist, dice: revealed ? dice : null }; }

function newRound() {
  round++; start = Date.now(); revealed = false;
  dice = [0, 0, 0].map(() => crypto.randomInt(1, 7)); // 開骰前只存在伺服器
  broadcast(stateMsg());
  for (const c of wss.clients) if (c.player) send(c, meMsg(c.player));
  pushPlayers();
}
function reveal() {
  revealed = true;
  hist.unshift({ round, dice }); hist = hist.slice(0, HIST);
  broadcast({ type: "roll", round, dice, hist });
  for (const p of players.values()) {
    if (p.round !== round || !Object.keys(p.bets).length) continue;
    let back = 0, st = 0;
    for (const [k, a] of Object.entries(p.bets)) { st += a; back += payout(k, a, dice); }
    p.balance += back; p.lastNet = back - st; p.settled = round;
  }
  // 結果在骰子動畫結束後才通知（約 2.6 秒）
  setTimeout(() => {
    for (const c of wss.clients) { const p = c.player; if (p && p.settled === round) send(c, { type: "settle", round, net: p.lastNet, balance: p.balance }); }
    pushPlayers();
  }, 2700);
}
setInterval(() => {
  const now = Date.now();
  if (!start || now >= start + ROUND) newRound();
  else if (!revealed && now >= start + BET_MS) reveal();
}, 100);

wss.on("connection", ws => {
  ws.isAlive = true; ws.on("pong", () => ws.isAlive = true);
  send(ws, stateMsg()); send(ws, playersMsg());
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const err = t => send(ws, { type: "error", text: t });
    if (m.type === "join") {
      const name = String(m.name || "").replace(/\s+/g, " ").trim().slice(0, 12);
      if (!name) return err("請輸入暱稱");
      let p = typeof m.token === "string" && players.get(m.token);
      let token = m.token;
      if (!p) {
        token = crypto.randomBytes(16).toString("hex");
        p = { id: crypto.randomBytes(6).toString("hex"), name, balance: START, bets: {}, round: 0, lastSeen: Date.now() };
        players.set(token, p);
      }
      p.name = name; p.lastSeen = Date.now(); ws.player = p;
      send(ws, { type: "joined", token }); send(ws, meMsg(p)); pushPlayers();
      return;
    }
    const p = ws.player; if (!p) return err("請先輸入暱稱入座");
    p.lastSeen = Date.now();
    const betting = !revealed && Date.now() < start + BET_MS;
    if (m.type === "bet") {
      if (!betting) return err("已停止下注");
      if (!KEYS.has(m.k) || !CHIPS.includes(m.amt)) return err("無效的下注");
      if (p.round !== round) { p.round = round; p.bets = {}; }
      if (p.balance < m.amt) return err("籌碼不足");
      if (staked(p) + m.amt > MAX_BET) return err("每局最多下注 100,000");
      p.balance -= m.amt; p.bets[m.k] = (p.bets[m.k] || 0) + m.amt;
      send(ws, meMsg(p)); pushPlayers();
    } else if (m.type === "clear") {
      if (!betting || p.round !== round) return;
      p.balance += staked(p); p.bets = {}; send(ws, meMsg(p)); pushPlayers();
    } else if (m.type === "refill") {
      if (p.balance >= 10 || staked(p)) return err("籌碼用完才能補充");
      p.balance = START; send(ws, meMsg(p)); send(ws, { type: "info", text: "已補滿 10,000 籌碼" }); pushPlayers();
    }
  });
  ws.on("close", pushPlayers);
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 25000);

process.on("SIGTERM", () => { persist(); process.exit(0); });
server.listen(PORT, () => console.log("鑫禾骰寶 running on port " + PORT));
