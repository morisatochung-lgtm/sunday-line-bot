// ── 台灣銀行日圓匯率查詢 ────────────────────────────────────────────────────────
// 資料來源：台灣銀行牌告匯率 CSV
//   https://rate.bot.com.tw/xrt/flcsv/0/day
// CSV 每列格式（與 twder 套件相同的欄位索引）：
//   [0] 幣別代碼  [2] 現金買入  [3] 現金賣出  [4] 即期買入  [5] 即期賣出 ...
const BOT_CSV_URL = 'https://rate.bot.com.tw/xrt/flcsv/0/day';

// 取得日圓匯率：回傳 { cashSell, spotSell, time }（數字為 1 日圓 = ? 新台幣）
async function getJpyRate() {
  const res = await fetch(BOT_CSV_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (sunday-line-bot)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`台銀回應 HTTP ${res.status}`);
  }
  const csv = await res.text();

  const line = csv
    .split('\n')
    .find((l) => l.trim().toUpperCase().startsWith('JPY'));
  if (!line) {
    throw new Error('CSV 中找不到 JPY 資料');
  }

  const cols = line.split(',');
  const cashSell = parseFloat(cols[3]); // 現金賣出（我們買日幣時看這個）
  const spotSell = parseFloat(cols[5]); // 即期賣出
  if (!Number.isFinite(cashSell)) {
    throw new Error('無法解析現金賣出匯率');
  }

  return {
    cashSell,
    spotSell: Number.isFinite(spotSell) ? spotSell : null,
    time: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
  };
}

// 把匯率組成適合手機閱讀的訊息。target 為目標價（現金賣出）。
function formatRateMessage(rate, target) {
  const { cashSell, spotSell, time } = rate;
  // 換 ¥10,000 需要多少台幣
  const per10k = Math.round(cashSell * 10000);
  const lines = [
    '🇯🇵 台銀日圓匯率',
    `・現金賣出：${cashSell}`,
    spotSell != null ? `・即期賣出：${spotSell}` : null,
    `・換 ¥10,000 約 NT$${per10k.toLocaleString('zh-TW')}`,
    `（查詢時間 ${time}）`,
    '',
  ].filter(Boolean);

  if (target != null) {
    if (cashSell <= target) {
      lines.push(`🔔 已達到你的目標價 ${target}！現在換很划算，可以分批進場 💰`);
    } else {
      const diff = (cashSell - target).toFixed(4);
      lines.push(`目標價 ${target}，還差 ${diff}。再等等或先換一小批。`);
    }
  }

  return lines.join('\n');
}

module.exports = { getJpyRate, formatRateMessage };
