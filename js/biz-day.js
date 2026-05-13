/* ============================================================
   js/biz-day.js  v20260613
   看板端營業日 (Business Day, BD) 共用工具
   邏輯與 POS 端 js/core/biz-day.js 完全一致（請同步修改）
   
   核心概念：
   - BD = 依店家 businessHours 切分的營業日單位
   - 跨日營業（例：14:00-03:00）視為同一個 BD
   - 公休日（businessHours[weekday] = []）不會產生 BD
   
   匯出函式：
   - getBusinessDay(time, businessHours) → 取得某時間點所屬的 BD 日期字串
   - getBDRange(bdDateStr, businessHours) → 取得某 BD 的起訖 Date
   - isOpenDay(dateStr, businessHours) → 判斷某日是否為營業日
   - getRecentBDs(n, businessHours, fromDate) → 取得最近 N 個營業日
   - getBDsBetween(fromBD, toBD, businessHours) → 取得區間內所有營業日
   ============================================================ */

const WEEKDAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];

function pad2(n){ return String(n).padStart(2,'0'); }

function fmtDate(d){
  return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate());
}

function parseDateStr(s){
  const m = String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2])-1, Number(m[3])) : null;
}

function timeToMinutes(t){
  const m = String(t||'').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

function getWeekdayKey(date){
  return WEEKDAY_KEYS[date.getDay()];
}

function getSlotsOfDay(date, businessHours){
  const key = getWeekdayKey(date);
  return (businessHours && Array.isArray(businessHours[key])) ? businessHours[key] : [];
}

// 取得某時間點所屬的營業日 (BD)
// 回傳 YYYY-MM-DD，找不到任何符合的 slot 時 fallback 為當日（避免回傳空字串）
export function getBusinessDay(time, businessHours){
  const d = new Date(time);
  if(isNaN(d.getTime())) return '';
  const T = d.getHours() * 60 + d.getMinutes();

  // 先看當日的 slots（含跨日 slot 的前半段）
  const todaySlots = getSlotsOfDay(d, businessHours);
  for(const slot of todaySlots){
    const s = timeToMinutes(slot.start);
    const e = timeToMinutes(slot.end);
    if(s < 0 || e < 0) continue;
    if(e >= s){
      // 不跨日 slot：14:00-21:00
      if(T >= s && T <= e) return fmtDate(d);
    } else {
      // 跨日 slot：14:00-03:00，當日符合 T >= start
      if(T >= s) return fmtDate(d);
    }
  }

  // 再看前一天的 slots（跨日 slot 的後半段，例如 02:00 屬於昨天的 BD）
  const prev = new Date(d);
  prev.setDate(prev.getDate() - 1);
  const prevSlots = getSlotsOfDay(prev, businessHours);
  for(const slot of prevSlots){
    const s = timeToMinutes(slot.start);
    const e = timeToMinutes(slot.end);
    if(s < 0 || e < 0) continue;
    if(e < s && T <= e) return fmtDate(prev);
  }

  // 都沒符合 → fallback 為當日（不應該發生在正常營業時間內，但 fallback 保護）
  return fmtDate(d);
}

// 取得某 BD 的起訖時間（含跨日尾端）
// 回傳 { start: Date, end: Date, hasCrossDay: boolean } 或 null（公休日）
export function getBDRange(bdDateStr, businessHours){
  const base = parseDateStr(bdDateStr);
  if(!base) return null;
  const slots = getSlotsOfDay(base, businessHours);
  if(!slots.length) return null;

  let minStart = Infinity, maxEnd = -Infinity;
  let hasCrossDay = false;
  for(const slot of slots){
    const s = timeToMinutes(slot.start);
    const e = timeToMinutes(slot.end);
    if(s < 0 || e < 0) continue;
    if(s < minStart) minStart = s;
    if(e < s){
      hasCrossDay = true;
      // 跨日 slot 的 end 視為次日的同分鐘 → +1440 分鐘
      if(e + 1440 > maxEnd) maxEnd = e + 1440;
    } else if(e > maxEnd){
      maxEnd = e;
    }
  }

  if(minStart === Infinity || maxEnd === -Infinity) return null;

  const start = new Date(base);
  start.setHours(0, 0, 0, 0);
  start.setMinutes(minStart);
  const end = new Date(base);
  end.setHours(0, 0, 0, 0);
  end.setMinutes(maxEnd);
  return { start, end, hasCrossDay };
}

// 判斷某日（自然日）是否為營業日（該 weekday 有設定 slot）
export function isOpenDay(dateStr, businessHours){
  const d = parseDateStr(dateStr);
  return d ? getSlotsOfDay(d, businessHours).length > 0 : false;
}

// 取得最近 N 個營業日（往前找，不含未來），跳過公休日
// fromDate 預設為今天；回傳由新到舊的 BD 字串陣列
export function getRecentBDs(n, businessHours, fromDate){
  const out = [];
  if(!n || n < 1) return out;
  const MAX_SCAN = 365; // 防無限迴圈（若整年公休則放棄）
  const cur = fromDate ? new Date(fromDate) : new Date();
  cur.setHours(0, 0, 0, 0);
  for(let i = 0; i < MAX_SCAN && out.length < n; i++){
    if(getSlotsOfDay(cur, businessHours).length){
      out.push(fmtDate(cur));
    }
    cur.setDate(cur.getDate() - 1);
  }
  return out;
}

// 取得兩 BD 之間（含端點）的所有營業日，跳過公休日
export function getBDsBetween(fromBD, toBD, businessHours){
  const start = parseDateStr(fromBD);
  const end = parseDateStr(toBD);
  if(!start || !end || start > end) return [];
  const out = [];
  const cur = new Date(start);
  while(cur <= end){
    if(getSlotsOfDay(cur, businessHours).length){
      out.push(fmtDate(cur));
    }
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}
