# 鑫禾骰寶

多人同桌的網頁骰寶（虛擬籌碼，僅供娛樂）。玩家輸入暱稱即可入座，不需要任何帳號。

- `server.js`：Node.js 伺服器，負責開骰（伺服器端亂數，開骰前玩家看不到）、計算輸贏、保存籌碼，並用 WebSocket 即時同步。
- `public/index.html`：遊戲畫面。

## 本機試玩
```
npm install
npm start
```
打開 http://localhost:3000

## 部署到 Render（免費）
1. 把這個資料夾上傳到一個 GitHub 儲存庫。
2. 到 https://render.com 用 GitHub 登入，New → Web Service，選這個儲存庫。
3. Runtime 選 Node，Build Command 填 `npm install`，Start Command 填 `npm start`，方案選 Free，按 Create。
4. 部署完成後，上方的 `https://xxxx.onrender.com` 就是遊戲網址。

注意：免費方案閒置 15 分鐘會休眠，下次打開要等約 1 分鐘喚醒；伺服器重啟或重新部署後籌碼會重置。
