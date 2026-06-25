require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { OpenAI } = require('openai');
const { getJpyRate, formatRateMessage } = require('./currency');

const app = express();
const PORT = process.env.PORT || 3000;

// ── 日幣匯率提醒設定 ─────────────────────────────────────────────────────────────
// 目標價（台銀日圓現金賣出），可用環境變數覆蓋，預設 0.197
const JPY_TARGET_RATE = parseFloat(process.env.JPY_TARGET_RATE || '0.197');
// 訂閱到價推播的 userId 清單（記憶體儲存；重啟會清空）。
// 可用 ALERT_USER_ID 環境變數預先放入一位訂閱者，避免重啟後失效。
const alertSubscribers = new Set();
if (process.env.ALERT_USER_ID) {
  alertSubscribers.add(process.env.ALERT_USER_ID);
}
// 同一天只推播一次（以台北日期為準），避免洗版
let lastAlertDate = null;

// ── LINE 設定 ──────────────────────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

// ── OpenAI 設定 ────────────────────────────────────────────────────────────────
const openai = new OpenAI();

// 對話記憶（以 userId 為 key，保留最近 10 則）
const conversationHistory = {};

async function askAI(userId, userMessage) {
  if (!conversationHistory[userId]) {
    conversationHistory[userId] = [
      {
        role: 'system',
        content: `你是一個親切、實用的 LINE 機器人助理，名字叫 Sunday。
請用繁體中文回覆，語氣自然友善。
回覆請簡潔，適合手機閱讀（每則不超過 200 字）。`
      }
    ];
  }

  // 加入用戶訊息
  conversationHistory[userId].push({ role: 'user', content: userMessage });

  // 保留最近 10 則對話（不含 system）
  const history = conversationHistory[userId];
  const systemMsg = history[0];
  const recent = history.slice(1).slice(-10);
  const messages = [systemMsg, ...recent];

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: messages,
      max_tokens: 500,
      temperature: 0.7,
    });

    const aiReply = response.choices[0].message.content;

    // 儲存 AI 回覆到對話記憶
    conversationHistory[userId].push({ role: 'assistant', content: aiReply });

    return aiReply;
  } catch (err) {
    console.error('OpenAI 錯誤:', err.message);
    return '抱歉，目前 AI 服務暫時無法使用，請稍後再試。';
  }
}

// ── 健康檢查（放在 webhook 前面）─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '✅ Sunday LINE Bot 運行中',
    name: 'Sunday',
    time: new Date().toLocaleString('zh-TW'),
    webhook: '/webhook'
  });
});

// ── Webhook 路由 ───────────────────────────────────────────────────────────────
app.post('/webhook',
  line.middleware(lineConfig),
  async (req, res) => {
    res.status(200).json({ status: 'ok' });

    const events = req.body.events || [];
    for (const event of events) {
      await handleEvent(event);
    }
  }
);

async function handleEvent(event) {
  const ts = new Date().toLocaleTimeString('zh-TW');
  console.log(`[${ts}] 事件類型: ${event.type}`);

  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const userText = event.message.text;
  const replyToken = event.replyToken;

  console.log(`  用戶 ID: ${userId}`);
  console.log(`  訊息內容: ${userText}`);

  // ── 日幣匯率指令（優先於 AI 聊天）──────────────────────────────────────────
  const cmdReply = await handleCurrencyCommand(userId, userText);
  if (cmdReply) {
    await replyText(replyToken, cmdReply);
    return;
  }

  const aiReply = await askAI(userId, userText);
  console.log(`  AI 回覆: ${aiReply.substring(0, 60)}...`);

  await replyText(replyToken, aiReply);
}

// 回覆文字訊息
async function replyText(replyToken, text) {
  try {
    await lineClient.replyMessage({
      replyToken: replyToken,
      messages: [{ type: 'text', text }]
    });
    console.log(`  ✅ 回覆成功`);
  } catch (err) {
    console.error(`  ❌ 回覆失敗: ${err.message}`);
  }
}

// ── 匯率指令處理 ───────────────────────────────────────────────────────────────
// 回傳要回覆的文字；若非匯率指令則回傳 null（交給 AI 聊天）。
async function handleCurrencyCommand(userId, text) {
  const t = text.trim();

  // 查詢：匯率 / 日幣 / 日圓 / 日元
  if (/^(匯率|日幣|日圓|日元|jpy)/i.test(t)) {
    try {
      const rate = await getJpyRate();
      return formatRateMessage(rate, JPY_TARGET_RATE);
    } catch (err) {
      console.error('  ❌ 匯率查詢失敗:', err.message);
      return '抱歉，目前查不到台銀日圓匯率，請稍後再試 🙏';
    }
  }

  // 訂閱到價提醒
  if (/^(訂閱|開啟|設定)?(匯率)?(提醒|通知)$/.test(t) || t === '訂閱匯率' || t === '開啟提醒') {
    alertSubscribers.add(userId);
    return `🔔 已開啟日幣到價提醒！\n目標價（現金賣出）：${JPY_TARGET_RATE}\n一到價我會主動推播提醒你換錢 💰\n（輸入「取消提醒」可關閉）`;
  }

  // 取消提醒
  if (/^(取消|關閉)(匯率)?(提醒|通知)$/.test(t)) {
    alertSubscribers.delete(userId);
    return '已關閉日幣到價提醒。需要時輸入「提醒」可重新開啟 🙂';
  }

  return null;
}

// ── 每日到價自動檢查 ───────────────────────────────────────────────────────────
async function checkRateAndAlert() {
  if (alertSubscribers.size === 0) return;
  let rate;
  try {
    rate = await getJpyRate();
  } catch (err) {
    console.error('  ❌ 定時匯率檢查失敗:', err.message);
    return;
  }

  if (rate.cashSell > JPY_TARGET_RATE) return;

  // 同一天只推一次
  const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  if (lastAlertDate === today) return;
  lastAlertDate = today;

  const msg = '📢 日幣到價提醒\n\n' + formatRateMessage(rate, JPY_TARGET_RATE);
  for (const uid of alertSubscribers) {
    try {
      await lineClient.pushMessage({ to: uid, messages: [{ type: 'text', text: msg }] });
      console.log(`  🔔 已推播到價提醒給 ${uid}`);
    } catch (err) {
      console.error(`  ❌ 推播失敗 (${uid}): ${err.message}`);
    }
  }
}

// 啟動定時檢查：每 3 小時查一次（同一天只會推播一次）
function startRateWatcher() {
  const THREE_HOURS = 3 * 60 * 60 * 1000;
  setInterval(checkRateAndAlert, THREE_HOURS);
  // 啟動後 1 分鐘先檢查一次
  setTimeout(checkRateAndAlert, 60 * 1000);
}

// ── 錯誤處理 ───────────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('伺服器錯誤:', err.message);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ── 啟動伺服器 ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Sunday LINE Bot 伺服器已啟動 (Port: ${PORT})\n`);
  console.log(`🇯🇵 日幣到價提醒已啟用，目標價（現金賣出）：${JPY_TARGET_RATE}\n`);
  startRateWatcher();
});
