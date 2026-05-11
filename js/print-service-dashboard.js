/* ============================================================
   js/print-service-dashboard.js
   看板專用列印服務（簡化版，只支援 receipt 模式）
   - 與 POS 同樣走 print-bridge.js 的 HTTP 橋接（T2 上直印）
   - 非 T2 環境自動 fallback 到瀏覽器系統列印
   - 支援 58mm / 80mm 紙寬切換
   - 提供報表專用的 receipt 生成（不是訂單格式）
   ============================================================ */

import { detectPrinters, getCachedDetect, httpPrint, browserPrintHtml } from './print-bridge.js';

// ============================================================
// 工具
// ============================================================
function escapeHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function money(v){
  return '$' + Number(v || 0).toLocaleString('zh-TW');
}

function pad(n){ return String(n).padStart(2,'0'); }

function fmtDate(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return String(iso);
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}

function fmtDateTime(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return String(iso);
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ============================================================
// HTML 生成（瀏覽器列印 fallback 用）
// ============================================================
/**
 * 生成報表的 HTML（單頁，自適應紙寬）
 * @param {Object} report - { title, subtitle, sections: [{header, rows: [[label, value], ...]}], footer }
 * @param {Number} paperWidthMm - 58 或 80
 */
export function buildReportHtml(report, paperWidthMm = 58){
  const fontSize = paperWidthMm >= 80 ? 13 : 12;
  const titleSize = fontSize + 4;
  const sectionSize = fontSize + 1;

  const sections = (report.sections || []).map(sec => {
    const rows = (sec.rows || []).map(r => {
      if(Array.isArray(r)){
        const [label, value] = r;
        if(value === undefined || value === null || value === ''){
          return `<div class="full">${escapeHtml(label)}</div>`;
        }
        return `<div class="row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
      }
      return `<div class="full">${escapeHtml(String(r))}</div>`;
    }).join('');
    return `
      <div class="section">
        ${sec.header ? `<div class="section-title">${escapeHtml(sec.header)}</div>` : ''}
        ${rows}
      </div>
    `;
  }).join('<div class="sep"></div>');

  const css = `
    <style>
      @page { size: ${paperWidthMm}mm auto; margin: 0; }
      html, body { margin: 0; padding: 0; }
      body {
        font-family: "PingFang TC","Microsoft JhengHei","Heiti TC", sans-serif;
        font-size: ${fontSize}px;
        width: ${paperWidthMm}mm;
        padding: 4mm 3mm;
        color: #000;
        line-height: 1.5;
      }
      .center { text-align: center; }
      .bold { font-weight: 700; }
      .title { font-size: ${titleSize}px; font-weight: 700; text-align: center; }
      .subtitle { font-size: ${fontSize - 1}px; text-align: center; color: #333; margin-top: 2px; }
      .section-title { font-size: ${sectionSize}px; font-weight: 700; margin-top: 4px; }
      .sep { border-top: 1px dashed #000; margin: 6px 0; }
      .row { display: flex; justify-content: space-between; gap: 8px; word-break: break-all; }
      .full { word-break: break-all; }
      .section { margin: 2px 0; }
    </style>
  `;

  return `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>
    <div class="title">${escapeHtml(report.title || '報表')}</div>
    ${report.subtitle ? `<div class="subtitle">${escapeHtml(report.subtitle)}</div>` : ''}
    <div class="sep"></div>
    ${sections}
    ${report.footer ? `<div class="sep"></div><div class="center">${escapeHtml(report.footer)}</div>` : ''}
  </body></html>`;
}

// ============================================================
// Bridge Payload 生成（HTTP 橋接給 T2 APK 用）
// ============================================================
/**
 * 把報表轉成 APK 看得懂的 payload
 * APK 端原本是設計來印訂單的，這裡我們複用 items 結構模擬報表行
 */
function buildReportPayload(report, paperWidthMm){
  // 把 sections 攤平成 items（每行一個 item），APK 會逐行印
  const items = [];
  (report.sections || []).forEach((sec, idx) => {
    if(idx > 0){
      // 區塊間加分隔（用空白 item 製造空行）
      items.push({ name: '--------------------------------', qty: 1, basePrice: 0, extraPrice: 0, price: 0, options: '', note: '' });
    }
    if(sec.header){
      items.push({ name: '【' + sec.header + '】', qty: 1, basePrice: 0, extraPrice: 0, price: 0, options: '', note: '' });
    }
    (sec.rows || []).forEach(r => {
      if(Array.isArray(r)){
        const [label, value] = r;
        const name = value !== undefined && value !== null && value !== ''
          ? `${label}: ${value}`
          : label;
        items.push({ name, qty: 1, basePrice: 0, extraPrice: 0, price: 0, options: '', note: '' });
      } else {
        items.push({ name: String(r), qty: 1, basePrice: 0, extraPrice: 0, price: 0, options: '', note: '' });
      }
    });
  });

  return {
    mode: 'receipt',
    fields: {
      storeName: true, storePhone: false, storeAddress: false,
      orderNo: false, dateTime: false, orderType: false, customerInfo: false,
      items: true, itemPrice: false, itemQty: false, itemNote: false,
      subtotal: false, discount: false, total: false,
      paymentMethod: false, orderNote: false, footer: true,
      itemSelections: false
    },
    openDrawer: false,
    shopName: report.title || '報表',
    shopPhone: '',
    shopAddress: '',
    subtitle: report.subtitle || '',
    footer: report.footer || '',
    orderNumber: '',
    dateTime: '',
    orderType: '',
    tableNo: '',
    paymentMethod: '',
    customerName: '',
    customerPhoneMasked: '',
    customerNote: '',
    items,
    subtotal: 0,
    discountAmount: 0,
    total: 0,
    // 紙寬透過 receiptPaperWidth 傳給 APK 參考（APK 預設 80）
    receiptPaperWidth: paperWidthMm
  };
}

// ============================================================
// 主列印 API
// ============================================================
/**
 * 列印報表
 * @param {Object} report - { title, subtitle, sections, footer }
 * @param {Object} options - { paperWidth: 58 | 80 }
 * @returns {Promise<{route: string, ok: boolean}>}
 */
export async function printReport(report, options = {}){
  const paperWidth = Number(options.paperWidth || 58);
  const html = buildReportHtml(report, paperWidth);
  const payload = buildReportPayload(report, paperWidth);

  // 偵測印表機
  await detectPrinters(true);
  const d = getCachedDetect();
  console.log('[print-service-dashboard] detect mode=', d && d.mode, 'sunmi=', d && d.sunmi);

  // 在 T2 上：走 HTTP 橋接
  if (d && d.mode === 'http') {
    if (d.sunmi) {
      const r = await httpPrint('sunmi', payload);
      if (r.ok) return { route: 'http-sunmi', ok: true };
      console.warn('[print-service-dashboard] http-sunmi failed:', r.error);
    }
    if (d.bluetooth) {
      const r = await httpPrint('bluetooth', payload);
      if (r.ok) return { route: 'http-bluetooth', ok: true };
      console.warn('[print-service-dashboard] http-bluetooth failed:', r.error);
    }
    if (d.network) {
      const r = await httpPrint('network', payload);
      if (r.ok) return { route: 'http-network', ok: true };
      console.warn('[print-service-dashboard] http-network failed:', r.error);
    }
    console.warn('[print-service-dashboard] http 全部失敗，fallback browser');
  }

  // Fallback：瀏覽器系統列印對話框
  await browserPrintHtml(html);
  return { route: 'browser', ok: true };
}

/**
 * 預覽報表（在 modal 內顯示，不直接送印）
 * @param {Object} report
 * @param {Number} paperWidthMm
 * @returns {string} HTML 字串
 */
export function previewReport(report, paperWidthMm = 58){
  return buildReportHtml(report, paperWidthMm);
}

// ============================================================
// 報表資料 → report 物件 的轉換器
// ============================================================
/**
 * 營業彙總報表：每店每日總額、訂單數、客單價、付款分項
 * @param {Object} data - { dateFrom, dateTo, stores: [{ storeId, storeName, days: [{date, salesTotal, orderCount, payments}] }] }
 */
export function buildSummaryReport(data){
  const sections = [];

  let grandSales = 0;
  let grandOrders = 0;
  const grandPayments = {};

  (data.stores || []).forEach(store => {
    const rows = [];
    let storeSales = 0;
    let storeOrders = 0;
    const storePayments = {};

    (store.days || []).forEach(day => {
      rows.push([day.date, money(day.salesTotal) + ` (${day.orderCount}單)`]);
      storeSales += Number(day.salesTotal || 0);
      storeOrders += Number(day.orderCount || 0);
      Object.entries(day.payments || {}).forEach(([pm, info]) => {
        if(!storePayments[pm]) storePayments[pm] = { amount: 0, count: 0 };
        storePayments[pm].amount += Number(info.amount || 0);
        storePayments[pm].count += Number(info.count || 0);
      });
    });

    if(rows.length === 0){
      rows.push(['(無資料)', '']);
    }

    rows.push(['─────────', '─────────']);
    rows.push(['小計營業額', money(storeSales)]);
    rows.push(['小計訂單數', storeOrders + ' 單']);
    rows.push(['客單價', money(storeOrders > 0 ? Math.round(storeSales / storeOrders) : 0)]);

    if(Object.keys(storePayments).length > 0){
      rows.push(['付款方式', '']);
      Object.entries(storePayments).forEach(([pm, info]) => {
        rows.push(['  ' + pm, money(info.amount) + ` (${info.count}單)`]);
      });
    }

    sections.push({
      header: store.storeName || store.storeId,
      rows
    });

    grandSales += storeSales;
    grandOrders += storeOrders;
    Object.entries(storePayments).forEach(([pm, info]) => {
      if(!grandPayments[pm]) grandPayments[pm] = { amount: 0, count: 0 };
      grandPayments[pm].amount += info.amount;
      grandPayments[pm].count += info.count;
    });
  });

  // 總計區塊
  if((data.stores || []).length > 1){
    const totalRows = [];
    totalRows.push(['總營業額', money(grandSales)]);
    totalRows.push(['總訂單數', grandOrders + ' 單']);
    totalRows.push(['平均客單', money(grandOrders > 0 ? Math.round(grandSales / grandOrders) : 0)]);
    if(Object.keys(grandPayments).length > 0){
      totalRows.push(['付款方式', '']);
      Object.entries(grandPayments).forEach(([pm, info]) => {
        totalRows.push(['  ' + pm, money(info.amount) + ` (${info.count}單)`]);
      });
    }
    sections.push({ header: '★ 總計', rows: totalRows });
  }

  return {
    title: '營業彙總報表',
    subtitle: `${data.dateFrom} ~ ${data.dateTo}`,
    sections,
    footer: '列印時間：' + fmtDateTime(new Date().toISOString())
  };
}

/**
 * 班次明細報表
 * @param {Object} data - { dateFrom, dateTo, stores: [{ storeId, storeName, sessions: [...] }] }
 */
export function buildSessionReport(data){
  const sections = [];

  (data.stores || []).forEach(store => {
    const sessions = store.sessions || [];
    if(sessions.length === 0){
      sections.push({
        header: store.storeName || store.storeId,
        rows: [['(無班次資料)', '']]
      });
      return;
    }

    const rows = [];
    sessions.forEach(s => {
      const startTime = s.startedAt ? fmtDateTime(s.startedAt) : '?';
      const endTime = s.endedAt ? fmtDateTime(s.endedAt).slice(11) : '進行中';
      rows.push([`${startTime} ~ ${endTime}`, '']);
      rows.push(['  人員', s.staffId || '?']);
      rows.push(['  營業額', money(s.stats?.salesTotal || 0)]);
      rows.push(['  訂單數', (s.stats?.orderCount || 0) + ' 單']);
      rows.push(['  開班', money(s.openingCash || 0)]);
      rows.push(['  結班', s.endedAt ? money(s.closingCash || 0) : '-']);
      rows.push(['  應收', s.endedAt ? money(s.expectedCash || 0) : '-']);
      const diff = Number(s.cashDiff || 0);
      if(s.endedAt){
        const diffStr = diff === 0 ? '$0 ✓' : (diff > 0 ? '+' + money(diff) : '-' + money(Math.abs(diff)));
        rows.push(['  差額', diffStr]);
      }
      if(s.note){
        rows.push(['  備註', s.note]);
      }
      rows.push(['', '']);
    });

    sections.push({
      header: store.storeName || store.storeId,
      rows
    });
  });

  return {
    title: '班次明細報表',
    subtitle: `${data.dateFrom} ~ ${data.dateTo}`,
    sections,
    footer: '列印時間：' + fmtDateTime(new Date().toISOString())
  };
}

/**
 * 訂單明細報表
 * @param {Object} data - { date, stores: [{ storeId, storeName, orders: [...] }] }
 */
export function buildOrderDetailReport(data){
  const sections = [];

  (data.stores || []).forEach(store => {
    const orders = store.orders || [];
    if(orders.length === 0){
      sections.push({
        header: store.storeName || store.storeId,
        rows: [['(無訂單)', '']]
      });
      return;
    }

    const rows = [];
    orders.forEach((o, idx) => {
      if(idx > 0) rows.push(['', '']);
      rows.push([`#${o.orderNo || o.id || '?'}`, money(o.total || 0)]);
      rows.push(['  時間', fmtDateTime(o.createdAt).slice(11)]);
      rows.push(['  類型', o.orderType || '?']);
      rows.push(['  付款', o.paymentMethod || '?']);
      if(Number(o.discountAmount || 0) > 0){
        rows.push(['  折扣', '-' + money(o.discountAmount)]);
      }
      (o.items || []).forEach(it => {
        const qty = Number(it.qty || 1);
        const unitPrice = Number(it.basePrice || 0) + Number(it.extraPrice || 0);
        rows.push([`  ${it.name} x${qty}`, money(unitPrice * qty)]);
        if(it.options){
          rows.push([`    ${it.options}`, '']);
        }
        if(it.note){
          rows.push([`    備註: ${it.note}`, '']);
        }
      });
    });

    sections.push({
      header: `${store.storeName || store.storeId} (${orders.length} 單)`,
      rows
    });
  });

  return {
    title: '訂單明細報表',
    subtitle: data.date || '',
    sections,
    footer: '列印時間：' + fmtDateTime(new Date().toISOString())
  };
}

/**
 * 異常訂單報表（拒單 / 折扣單）
 * @param {Object} data - { dateFrom, dateTo, rejectedOrders: [...], discountOrders: [...] }
 */
export function buildAnomalyReport(data){
  const sections = [];

  // 拒單區塊
  const rejected = data.rejectedOrders || [];
  if(rejected.length > 0){
    const rows = [];
    rejected.forEach(o => {
      rows.push([`#${o.orderNo || o.id}`, money(o.total || o.subtotal || 0)]);
      rows.push(['  店鋪', o.storeCode || '?']);
      rows.push(['  時間', fmtDateTime(o.createdAt)]);
      rows.push(['  顧客', `${o.customerName || '匿名'} ${o.customerPhone || ''}`]);
      if(o.replyMessage) rows.push(['  原因', o.replyMessage]);
      rows.push(['', '']);
    });
    sections.push({ header: `🚫 拒單 (${rejected.length})`, rows });
  }

  // 折扣單區塊
  const discounted = data.discountOrders || [];
  if(discounted.length > 0){
    const rows = [];
    let totalDiscount = 0;
    discounted.forEach(o => {
      const disc = Number(o.discountAmount || 0);
      totalDiscount += disc;
      rows.push([`#${o.orderNo || o.id}`, '-' + money(disc)]);
      rows.push(['  店鋪', o.storeCode || '?']);
      rows.push(['  時間', fmtDateTime(o.createdAt)]);
      rows.push(['  原金額', money(o.subtotal || 0)]);
      rows.push(['  實收', money(o.total || 0)]);
      rows.push(['', '']);
    });
    rows.push(['折扣總計', '-' + money(totalDiscount)]);
    sections.push({ header: `🎫 折扣單 (${discounted.length})`, rows });
  }

  if(sections.length === 0){
    sections.push({
      header: '異常訂單',
      rows: [['(查無異常單)', '']]
    });
  }

  return {
    title: '異常訂單報表',
    subtitle: `${data.dateFrom} ~ ${data.dateTo}`,
    sections,
    footer: '列印時間：' + fmtDateTime(new Date().toISOString())
  };
}

// ============================================================
// CSV 匯出
// ============================================================
/**
 * 把資料轉成 CSV 並下載
 * @param {Array<Array>} rows - 二維陣列，第一列是 header
 * @param {string} filename
 */
export function exportCSV(rows, filename){
  const csv = rows.map(row => row.map(cell => {
    const s = String(cell == null ? '' : cell);
    // 含逗號、引號、換行的話需要包引號
    if(/[",\n]/.test(s)){
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }).join(',')).join('\n');

  // 加 BOM 讓 Excel 正確顯示中文
  const bom = '\uFEFF';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || ('report_' + Date.now() + '.csv');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 營業彙總 CSV 結構
 */
export function summaryToCSV(data){
  const rows = [
    ['店鋪', '日期', '營業額', '訂單數', '客單價', '付款方式明細']
  ];
  (data.stores || []).forEach(store => {
    (store.days || []).forEach(day => {
      const paymentDetail = Object.entries(day.payments || {})
        .map(([pm, info]) => `${pm}:${info.amount}(${info.count}單)`)
        .join('; ');
      rows.push([
        store.storeName || store.storeId,
        day.date,
        day.salesTotal,
        day.orderCount,
        day.orderCount > 0 ? Math.round(day.salesTotal / day.orderCount) : 0,
        paymentDetail
      ]);
    });
  });
  return rows;
}

/**
 * 班次 CSV 結構
 */
export function sessionsToCSV(data){
  const rows = [
    ['店鋪', '開班時間', '結班時間', '人員', '營業額', '訂單數', '開班現金', '結班現金', '應收', '差額', '備註']
  ];
  (data.stores || []).forEach(store => {
    (store.sessions || []).forEach(s => {
      rows.push([
        store.storeName || store.storeId,
        fmtDateTime(s.startedAt),
        s.endedAt ? fmtDateTime(s.endedAt) : '進行中',
        s.staffId || '',
        s.stats?.salesTotal || 0,
        s.stats?.orderCount || 0,
        s.openingCash || 0,
        s.closingCash || '',
        s.expectedCash || '',
        s.cashDiff || '',
        s.note || ''
      ]);
    });
  });
  return rows;
}

/**
 * 訂單 CSV 結構
 */
export function ordersToCSV(data){
  const rows = [
    ['店鋪', '訂單號', '時間', '類型', '付款', '小計', '折扣', '總額', '品項']
  ];
  (data.stores || []).forEach(store => {
    (store.orders || []).forEach(o => {
      const itemsStr = (o.items || []).map(it => {
        const qty = Number(it.qty || 1);
        const opts = it.options ? `(${it.options})` : '';
        return `${it.name}${opts}x${qty}`;
      }).join('; ');
      rows.push([
        store.storeName || store.storeId,
        o.orderNo || o.id || '',
        fmtDateTime(o.createdAt),
        o.orderType || '',
        o.paymentMethod || '',
        o.subtotal || 0,
        o.discountAmount || 0,
        o.total || 0,
        itemsStr
      ]);
    });
  });
  return rows;
}

/**
 * 異常單 CSV 結構
 */
export function anomalyToCSV(data){
  const rows = [
    ['類型', '店鋪', '訂單號', '時間', '顧客', '金額', '折扣', '原因/備註']
  ];
  (data.rejectedOrders || []).forEach(o => {
    rows.push([
      '拒單',
      o.storeCode || '',
      o.orderNo || o.id || '',
      fmtDateTime(o.createdAt),
      `${o.customerName || ''} ${o.customerPhone || ''}`.trim(),
      o.total || o.subtotal || 0,
      '',
      o.replyMessage || ''
    ]);
  });
  (data.discountOrders || []).forEach(o => {
    rows.push([
      '折扣',
      o.storeCode || '',
      o.orderNo || o.id || '',
      fmtDateTime(o.createdAt),
      '',
      o.total || 0,
      o.discountAmount || 0,
      `原價 ${o.subtotal || 0}`
    ]);
  });
  return rows;
}

// ============================================================
// 工具：日期區間
// ============================================================
export function getDateRange(preset){
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fmt = d => d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());

  switch(preset){
    case 'today':
      return { from: fmt(today), to: fmt(today) };
    case 'yesterday': {
      const y = new Date(today); y.setDate(y.getDate()-1);
      return { from: fmt(y), to: fmt(y) };
    }
    case '7d': {
      const start = new Date(today); start.setDate(start.getDate()-6);
      return { from: fmt(start), to: fmt(today) };
    }
    case '30d': {
      const start = new Date(today); start.setDate(start.getDate()-29);
      return { from: fmt(start), to: fmt(today) };
    }
    case '60d': {
      const start = new Date(today); start.setDate(start.getDate()-59);
      return { from: fmt(start), to: fmt(today) };
    }
    default:
      return { from: fmt(today), to: fmt(today) };
  }
}

/**
 * 取得指定區間內的所有日期字串（YYYY-MM-DD）
 */
export function getDatesInRange(from, to){
  const dates = [];
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  if(isNaN(start.getTime()) || isNaN(end.getTime())) return dates;
  const cur = new Date(start);
  while(cur <= end){
    dates.push(cur.getFullYear() + '-' + pad(cur.getMonth()+1) + '-' + pad(cur.getDate()));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}
