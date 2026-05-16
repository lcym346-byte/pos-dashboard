/* ============================================================
   js/history-loader.js  v20260516a
   從 Firebase 撈 60 天歷史並整理成報表 builder 要的格式
   依賴：firebase-app.js / firebase-database.js（由 index.html 提供 db 實例）
   
   v20260516a 修正：
   - getStoreBusinessHours: 相容新版 {mon:[{start,end}],...} 七天 slot 結構
     （舊版 {openTime,closeTime} 也保留相容）
   - getDateRange: getRecentBDs 回傳由新到舊，'from' 應取 arr[arr.length-1]
   ============================================================ */

import { ref, get, child } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { getBusinessDay, getRecentBDs, getBDsBetween } from './biz-day.js';

// ============================================================
// 工具
// ============================================================
function pad(n){ return String(n).padStart(2, '0'); }

function localDateKey(input){
  if(!input) return '';
  const d = new Date(input);
  if(isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}

function isVoidedStatus(status){
  const s = String(status || '').toLowerCase();
  return s === 'void' || s === 'cancelled' || s === 'refunded';
}

// ============================================================
// 把舊版扁平 businessHours 轉成新版七天 slot 結構
// 舊版：{ openTime: '14:00', closeTime: '03:00' }（每天都營業）
// 新版：{ sun:[{start,end}], mon:[{start,end}], ... }
// ============================================================
const WEEKDAY_KEYS_HL = ['sun','mon','tue','wed','thu','fri','sat'];
function normalizeBusinessHours(v){
  if(!v || typeof v !== 'object') return null;
  // 新版：含任一 weekday key 且為陣列
  const hasNew = WEEKDAY_KEYS_HL.some(k => Array.isArray(v[k]));
  if(hasNew) return v;
  // 舊版扁平：補成七天都營業
  if(v.openTime && v.closeTime){
    const slot = [{ start: v.openTime, end: v.closeTime }];
    const out = {};
    WEEKDAY_KEYS_HL.forEach(k => { out[k] = slot; });
    return out;
  }
  return null;
}

// ============================================================
// 取得單店營業時段（從 dashboards/{storeId}/businessHours）
// fallback：14:00 - 03:00（跨日，七天都營業）
// ============================================================
async function getStoreBusinessHours(db, storeId){
  try{
    const snap = await get(ref(db, `dashboards/${storeId}/businessHours`));
    const v = snap.val();
    const norm = normalizeBusinessHours(v);
    if(norm) return norm;
  }catch(err){
    console.warn(`[history-loader] 讀 businessHours/${storeId} 失敗`, err);
  }
  // fallback：14:00-03:00，七天都營業
  const slot = [{ start: '14:00', end: '03:00' }];
  return {
    sun: slot, mon: slot, tue: slot, wed: slot,
    thu: slot, fri: slot, sat: slot
  };
}

// 用本機時區產生今天 YYYY-MM-DD
export function todayKey(){
  return localDateKey(new Date());
}

// 列出區間內所有日期字串
export function getDatesInRange(from, to){
  const out = [];
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  if(isNaN(start.getTime()) || isNaN(end.getTime())) return out;
  const cur = new Date(start);
  while(cur <= end){
    out.push(cur.getFullYear() + '-' + pad(cur.getMonth()+1) + '-' + pad(cur.getDate()));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// ============================================================
// 列出所有 storeId（讀 dashboards 根節點）
// 回傳：[{ storeId, storeName }, ...]
// ============================================================
export async function listStores(db){
  const snap = await get(ref(db, 'dashboards'));
  const data = snap.val() || {};
  return Object.entries(data).map(([storeId, d]) => {
    const heartbeat = (d && d.heartbeat) || {};
    return {
      storeId,
      storeName: heartbeat.storeName || storeId
    };
  });
}

// ============================================================
// 載入 60 天內歷史
// ============================================================
export async function loadHistory(db, storeIds, dateFrom, dateTo){
  // 1. 先解出要撈哪些店
  let targetStoreIds = (storeIds && storeIds.length) ? storeIds.slice() : null;
  let storeNameMap = {};

  // 從 dashboards 取得 storeName
  try {
    const allStores = await listStores(db);
    allStores.forEach(s => { storeNameMap[s.storeId] = s.storeName; });
    if(!targetStoreIds){
      targetStoreIds = allStores.map(s => s.storeId);
    }
  } catch(err){
    console.warn('[history-loader] listStores 失敗', err);
    if(!targetStoreIds) targetStoreIds = [];
  }

  const bdDates = getDatesInRange(dateFrom, dateTo); // 仍是自然日清單，作為節點 key 使用

  // 2. 逐店逐日去撈 sessionHistory/{storeId}/{date}
  const result = {
    dateFrom,
    dateTo,
    stores: [],
    rejectedOrders: [],
    discountOrders: []
  };

  for(const sid of targetStoreIds){
    const storeBlock = {
      storeId: sid,
      storeName: storeNameMap[sid] || sid,
      sessions: [],
      orders: [],
      days: []
    };

    // 取得該店 businessHours，並用 BD 列出區間內所有營業日當作節點 key
    const bh = await getStoreBusinessHours(db, sid);
    let storeBDs = getBDsBetween(dateFrom, dateTo, bh);

    // v20260516a 防呆：若 getBDsBetween 因 businessHours 異常回傳空陣列，
    // 退回用自然日清單，避免整個區間都不撈
    if(storeBDs.length === 0){
      console.warn(`[history-loader] ${sid} 的 businessHours 解析後無營業日，改用自然日清單`);
      storeBDs = bdDates;
    }

    // 並行撈該店所有 BD 節點，限制併發 8
    const concurrency = 8;
    for(let i = 0; i < storeBDs.length; i += concurrency){
      const chunk = storeBDs.slice(i, i + concurrency);

      const snaps = await Promise.all(
        chunk.map(d => get(ref(db, `sessionHistory/${sid}/${d}`)).catch(err => {
          console.warn(`[history-loader] 讀 sessionHistory/${sid}/${d} 失敗`, err);
          return null;
        }))
      );

      snaps.forEach((snap, idx) => {
        if(!snap) return;
        const dayData = snap.val();
        if(!dayData) return;

        Object.values(dayData).forEach(session => {
          if(!session) return;
          storeBlock.sessions.push(session);
          const sessionOrders = Array.isArray(session.orders) ? session.orders : [];
          sessionOrders.forEach(o => {
            const enriched = Object.assign({}, o, {
              storeId: sid,
              storeName: storeBlock.storeName,
              sessionId: session.sessionId || ''
            });
            storeBlock.orders.push(enriched);

            if(Number(o.discountAmount || 0) > 0 && !isVoidedStatus(o.status)){
              result.discountOrders.push(enriched);
            }
            if(isVoidedStatus(o.status)){
              result.rejectedOrders.push(Object.assign({}, enriched, {
                replyMessage: o.voidedReason || ''
              }));
            }
          });
        });
      });
    }

    // 3. 把 orders 整理成每日彙總（用 BD 而非自然日）
    const dayMap = {};
    storeBlock.orders.forEach(o => {
      const baseTime = o.reservationAt || o.createdAt;
      let dk = getBusinessDay(baseTime, bh);
      // v20260516a：若 BD 計算失敗，退回自然日，避免整批資料被丟棄
      if(!dk) dk = localDateKey(baseTime);
      if(!dk) return;

      if(!dayMap[dk]){
        dayMap[dk] = {
          date: dk,
          salesTotal: 0,
          orderCount: 0,
          payments: {},
          voidedCount: 0,
          voidedAmount: 0,
          discountTotal: 0
        };
      }
      const day = dayMap[dk];
      const total = Number(o.total || 0);
      if(isVoidedStatus(o.status)){
        day.voidedCount += 1;
        day.voidedAmount += total;
        return;
      }
      day.orderCount += 1;
      day.salesTotal += total;
      day.discountTotal += Number(o.discountAmount || 0);
      const pm = String(o.paymentMethod || '其他').trim() || '其他';
      if(!day.payments[pm]) day.payments[pm] = { amount: 0, count: 0 };
      day.payments[pm].amount += total;
      day.payments[pm].count += 1;
    });
    storeBlock.days = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

    result.stores.push(storeBlock);
  }

  return result;
}

// ============================================================
// 取得單店「今日進行中」資料
// ============================================================
export async function loadTodayLive(db, storeId){
  const snap = await get(ref(db, `dashboards/${storeId}`));
  const v = snap.val() || {};
  return {
    storeId,
    storeName: (v.heartbeat && v.heartbeat.storeName) || storeId,
    heartbeat: v.heartbeat || null,
    today: v.today || null,
    session: v.session || null
  };
}

// ============================================================
// 快捷日期區間（v20260516a：修正 arr 索引、相容新版 businessHours）
// 注意：preset='today' 回傳的是「今天的 BD」
// ============================================================
export function getDateRange(preset, businessHours){
  // v20260516a：fallback 也改為七天 slot 結構
  const fallbackSlot = [{ start: '14:00', end: '03:00' }];
  let bh = normalizeBusinessHours(businessHours);
  if(!bh){
    bh = {
      sun: fallbackSlot, mon: fallbackSlot, tue: fallbackSlot, wed: fallbackSlot,
      thu: fallbackSlot, fri: fallbackSlot, sat: fallbackSlot
    };
  }
  const todayBD = getBusinessDay(new Date(), bh);

  // getRecentBDs 回傳：由新到舊（arr[0]=最新、arr[arr.length-1]=最舊）
  switch(preset){
    case 'today':
      return { from: todayBD, to: todayBD };
    case 'yesterday': {
      const arr = getRecentBDs(2, bh);
      // arr[0]=今天 BD、arr[1]=昨天 BD
      const y = arr[1] || arr[0] || todayBD;
      return { from: y, to: y };
    }
    case '7d': {
      const arr = getRecentBDs(7, bh);
      const earliest = arr[arr.length - 1] || todayBD;
      return { from: earliest, to: todayBD };
    }
    case '30d': {
      const arr = getRecentBDs(30, bh);
      const earliest = arr[arr.length - 1] || todayBD;
      return { from: earliest, to: todayBD };
    }
    case '60d': {
      const arr = getRecentBDs(60, bh);
      const earliest = arr[arr.length - 1] || todayBD;
      return { from: earliest, to: todayBD };
    }
    default:
      return { from: todayBD, to: todayBD };
  }
}
