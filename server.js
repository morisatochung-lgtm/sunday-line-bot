require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { OpenAI } = require('openai');

const app = express();
const PORT = 3000;

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
        content: `你是一個親切、實用的 LINE 機器人助理。
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

// ── Webhook 路由 ───────────────────────────────────────────────────────────────

// LINE 簽名驗證中介層
app.post('/webhook',
  line.middleware(lineConfig),
  async (req, res) => {
    res.status(200).json({ status: 'ok' });

    const events = req.body.events;
    for (const event of events) {
      await handleEvent(event);
    }
  }
);

async function handleEvent(event) {
  console.log(`[${new Date().toLocaleTimeString('zh-TW')}] 事件類型: ${event.type}`);

  // 只處理文字訊息
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const userId = event.source.userId;
  const userText = event.message.text;
  const replyToken = event.replyToken;

  console.log(`  用戶 ID: ${userId}`);
  console.log(`  訊息內容: ${userText}`);

  // 取得 AI 回覆
  const aiReply = await askAI(userId, userText);
  console.log(`  AI 回覆: ${aiReply.substring(0, 60)}...`);

  // 回覆訊息
  try {
    await lineClient.replyMessage({
      replyToken: replyToken,
      messages: [{ type: 'text', text: aiReply }]
    });
    console.log(`  ✅ 回覆成功`);
  } catch (err) {
    console.error(`  ❌ 回覆失敗: ${err.message}`);
  }
}

// ── 健康檢查 ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '✅ LINE Webhook 伺服器運行中',
    time: new Date().toLocaleString('zh-TW'),
    endpoints: {
      webhook: 'POST /webhook',
      health: 'GET /'
    }
  });
});

// ── 啟動伺服器 ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   LINE Webhook 伺服器已啟動              ║');
  console.log(`║   Port: ${PORT}                              ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('等待 LINE 訊息中...');
  console.log('');
});
