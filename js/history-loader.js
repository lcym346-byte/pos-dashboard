/* ============================================================
   js/history-loader.js  v20260608
   從 Firebase 撈 60 天歷史並整理成報表 builder 要的格式
   依賴：firebase-app.js / firebase-database.js（由 index.html 提供 db 實例）
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
// 取得單店營業時段（從 dashboards/{storeId}/businessHours）
// fallback：14:00 - 03:00（跨日）
// ============================================================
async function getStoreBusinessHours(db, storeId){
  try{
    const snap = await get(ref(db, `dashboards/${storeId}/businessHours`));
    const v = snap.val();
    if(v && v.openTime && v.closeTime) return v;
  }catch(err){
    console.warn(`[history-loader] 讀 businessHours/${storeId} 失敗`, err);
  }
  return { openTime: '14:00', closeTime: '03:00' };
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
// 參數：
//   db          - Firebase database 實例
//   storeIds    - 要撈的店鋪 ID 陣列；空陣列 = 全部
//   dateFrom    - 'YYYY-MM-DD'
//   dateTo      - 'YYYY-MM-DD'
// 回傳：
//   {
//     dateFrom, dateTo,
//     stores: [{
//       storeId, storeName,
//       sessions: [...],           // 班次原始物件
//       orders: [...],             // 所有訂單（已含 storeId）
//       days: [{ date, salesTotal, orderCount, payments, voidedCount, voidedAmount, discountTotal }]
//     }],
//     rejectedOrders: [...],       // 跨店拒單列表（從 sessions 內找）
//     discountOrders: [...]        // 跨店折扣單列表
//   }
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

    // v20260613：dateFrom/dateTo 已是 BD 字串，逐店用各店 businessHours 展開區間
  // （區間內 BD 字串本身與 businessHours 無關，僅在分類訂單時才用到）
  const bdDates = getDatesInRange(dateFrom, dateTo); // 仍是自然日清單，作為節點 key 使用


  // 2. 逐店逐日去撈 sessionHistory/{storeId}/{date}
  //    （Firebase 不能 wildcard query，但每次 get 都是 O(該日節點大小)，
  //     60 天 * N 店 = 最多 60N 次 get，多店看板用戶通常 <10 店，效能可接受）
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

        // v20260613：取得該店 businessHours，並用 BD 列出區間內所有營業日當作節點 key
    const bh = await getStoreBusinessHours(db, sid);
    const storeBDs = getBDsBetween(dateFrom, dateTo, bh);

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

        // dayData = { sessionId1: {...}, sessionId2: {...} }
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

            // 折扣單
            if(Number(o.discountAmount || 0) > 0 && !isVoidedStatus(o.status)){
              result.discountOrders.push(enriched);
            }
            // 作廢單視為拒單
            if(isVoidedStatus(o.status)){
              result.rejectedOrders.push(Object.assign({}, enriched, {
                replyMessage: o.voidedReason || ''
              }));
            }
          });
        });
      });
    }

        // 3. 把 orders 整理成每日彙總（v20260613：用 BD 而非自然日）
    //    預約單以 reservationAt 為基準，其他用 createdAt
    const dayMap = {};
    storeBlock.orders.forEach(o => {
      const baseTime = o.reservationAt || o.createdAt;
      const dk = getBusinessDay(baseTime, bh);
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
// 取得單店「今日進行中」資料（從 dashboards/{storeId}，因為今日尚未結班不會在 sessionHistory）
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
// 快捷日期區間（v20260613：BD 版，需傳入 businessHours）
// 注意：preset='today' 回傳的是「今天的 BD」，可能與自然日不同
// （例：凌晨 2 點時，BD 仍是昨天）
// ============================================================
export function getDateRange(preset, businessHours){
  const bh = businessHours || { openTime: '14:00', closeTime: '03:00' };
  const todayBD = getBusinessDay(new Date(), bh);

  switch(preset){
    case 'today':
      return { from: todayBD, to: todayBD };
    case 'yesterday': {
      const arr = getRecentBDs(2, bh);
      return { from: arr[0], to: arr[0] }; // 索引 0 = 昨天 BD
    }
    case '7d': {
      const arr = getRecentBDs(7, bh);
      return { from: arr[0], to: todayBD };
    }
    case '30d': {
      const arr = getRecentBDs(30, bh);
      return { from: arr[0], to: todayBD };
    }
    case '60d': {
      const arr = getRecentBDs(60, bh);
      return { from: arr[0], to: todayBD };
    }
    default:
      return { from: todayBD, to: todayBD };
  }
}
