# 多店即時看板

> 餐廳 POS 系統的老闆端跨店即時營運看板,從 Firebase Realtime Database 讀取各門市資料,顯示即時營業狀況、班次資訊、付款分項、本週/本月累計、歷史報表(60 天 / 4 種類型)。

[![版本](https://img.shields.io/badge/version-v20260613-blue)]()
[![部署](https://img.shields.io/badge/deploy-GitHub%20Pages-green)]()
[![授權](https://img.shields.io/badge/license-Private-red)]()

---

## 目錄

1. [產品概述](#1-產品概述)
2. [系統架構](#2-系統架構)
3. [快速開始](#3-快速開始)
4. [功能說明](#4-功能說明)
5. [權限與登入](#5-權限與登入)
6. [Firebase 資料來源](#6-firebase-資料來源)
7. [歷史報表](#7-歷史報表)
8. [列印功能](#8-列印功能)
9. [檔案結構](#9-檔案結構)
10. [日常維運](#10-日常維運)
11. [故障排除](#11-故障排除)
12. [與 POS 端的依賴關係](#12-與-pos-端的依賴關係)
13. [開發守則](#13-開發守則)
14. [版本歷史](#14-版本歷史)

---

## 1. 產品概述

### 適用對象
連鎖餐飲店家的**老闆 / 區經理**,需要:
- 遠端即時監看所有門市營業狀況
- 一眼看出哪間店離線、哪間店班次未結、哪間店異常單偏多
- 跨店營業彙總(每店每日、跨店總計)
- 班次明細(現金差額追蹤)
- 訂單明細匯出(CSV)
- 異常單追蹤(拒單 + 折扣單)
- 隨身列印報表(58 mm / 80 mm)

### 核心功能
| 模組 | 說明 |
|---|---|
| **即時看板** | 每店一張卡片,顯示營業額、訂單數、客單價、付款分項、當前班次、本週/本月累計、異常單金額、外送 |
| **離線預警** | 更新超過 5 分鐘顯示「離線 X 分」,超過 60 分顯示「離線 X 小時」 |
| **班次未結預警** | 班次開超過 14 小時自動標紅(避免店員忘記結班) |
| **異常單預警** | 異常單(作廢/取消/退款)金額與筆數即時顯示 |
| **歷史報表** | 4 種報表(營業彙總/班次明細/訂單明細/異常單),最近 60 個營業日 |
| **列印** | 走 POS 同樣的橋接(127.0.0.1:8080),58/80 mm 自動切換 |
| **CSV 匯出** | 4 種報表都能匯出 Excel 可開的 UTF-8 BOM CSV |
| **權限管理** | 必須在 `staff/{uid}` 白名單,role 為 `admin` 或 `staff` |
| **本週/本月** | 自動從 sessionHistory 撈歷史 + 今日即時加總,60 秒快取 |

### 設計原則
1. **唯讀**:看板不寫任何資料回 Firebase(除了 auth 登入),完全被動觀察
2. **自動偵測**:不需手動加店家,只要 POS 端有寫入 `dashboards/{storeId}/`,看板自動列出
3. **快取友善**:本週/本月累計 60 秒 TTL,避免 onValue 高頻觸發時重複撈
4. **跨日支援**:用 BD(營業日)切今日,不用自然日 00:00–23:59
5. **離線顯示**:Firebase 連線斷時顯示「連線失敗」,不會空白

---

## 2. 系統架構

```
┌──────────────────────────────────────────────────────────────────┐
│                    多店 POS 終端機(各門市)                          │
│  store001 (Sunmi T2)    store002 (Sunmi T2)    store003 ...     │
│       │                       │                    │              │
│       └─ dashboard-publish.js(每 30 秒推一次)                     │
│           │                                                       │
│           ▼                                                       │
└───────────┼──────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Firebase Realtime Database                     │
│                          webpos-1f626                             │
│  dashboards/{storeId}/                                            │
│    ├── heartbeat   {storeName, lastSeenAt}                       │
│    ├── today       {salesTotal, orderCount, payments, voided,    │
│    │               delivery, ...}                                 │
│    ├── session     {staffId, startedAt, openingCash, ...}         │
│    ├── businessHours                                              │
│    └── _debug                                                     │
│                                                                   │
│  sessionHistory/{storeId}/{BD}/{sessionId}                        │
│                                                                   │
│  staff/{uid}  {email, name, role: admin|staff}                    │
└───────────┼──────────────────────────────────────────────────────┘
            │
            ▼ (Google 登入 → 讀取)
┌──────────────────────────────────────────────────────────────────┐
│              老闆端(瀏覽器:Chrome / Safari / 手機)                │
│  https://lcym346-byte.github.io/pos-dashboard/                  │
│  ├── 即時卡片(每店一張,30 秒輪詢 + onValue 即時)                 │
│  ├── 本週 / 本月累計(從 sessionHistory 撈,60 秒快取)              │
│  └── 歷史報表 Modal(60 BD,4 種報表類型,可預覽/列印/CSV)          │
└──────────────────────────────────────────────────────────────────┘
```

### 與相關專案的關係

| 角色 | Repo |
|---|---|
| 多店即時看板(本專案) | https://github.com/lcym346-byte/pos-dashboard |
| POS 主程式(總部範本) | https://github.com/jess0937588151-hue/2234 |
| POS 主程式(門市 1) | https://github.com/lcym346-byte/2237-1 |
| Sunmi 列印橋接 APK | https://github.com/jess0937588151-hue/sunmi-pos-v2 |

---

## 3. 快速開始

### 部署
1. Fork / Clone 本 Repo
2. GitHub Settings → Pages → Source: `main` / `(root)`
3. 等 1~2 分鐘部署完成
4. 訪問 `https://YOUR_USERNAME.github.io/pos-dashboard/`

### 開通使用者(看板權限)
1. 使用者用 Google 登入(會被擋下,因為不在白名單)
2. 從錯誤畫面複製該使用者的 UID
3. 管理員在 Firebase Console → Realtime Database → `staff/{uid}` 新增節點:
   ```json
   {
     "email": "boss@example.com",
     "name": "老闆",
     "role": "admin"
   }
   ```
4. 使用者重新整理 → 通過權限檢查 → 看到看板

### 自動列出店家
- 看板從 `dashboards/` 根節點讀取所有子節點
- POS 端只要設定好 `storeId` 並開啟,30 秒內就會出現在看板
- **不需要在看板任何地方手動加店**

---

## 4. 功能說明

### 即時卡片(每店一張)
顯示內容:
- **店名 + 線上/離線狀態**(綠/紅邊框)
- **最後更新時間**(timeAgo:X 秒前 / X 分鐘前 / X 小時前)
- **預警徽章**:離線 X 分 / 班次未結 X 小時
- **本週累計 / 本月累計**(從 sessionHistory + 今日加總)
- **營業額 / 訂單數 / 客單價**(主要 3 格)
- **異常單金額 / 異常單數 / 🛵 外送**(輔助 3 格)
- **支付方式分項**(現金、信用卡、行動支付、其他)
- **目前班次**(開班時間、人員、開班現金、目前現金)

### 預警邏輯
| 條件 | 顯示 |
|---|---|
| 更新 < 90 秒 | 「● 線上」綠色 |
| 更新 90 秒 ~ 5 分 | 「● 離線」紅色,但不顯示時長徽章 |
| 更新 5 分 ~ 60 分 | 紅色 + 「⚠ 離線 X 分」徽章 |
| 更新 ≥ 60 分 | 紅色 + 「⚠ 離線 X 小時」徽章 |
| 班次開啟 > 14 小時 | 紅色 + 「⚠ 班次未結 X 小時」徽章 |
| 異常單 > 0 | 異常欄位變紅色,前面加負號(-$xxx) |

### 本週 / 本月累計
- 本週 = 本週週一 至 昨天 的 sessionHistory 加總 + 今日 dashboards.today.salesTotal
- 本月 = 本月 1 日 至 昨天 的 sessionHistory 加總 + 今日 dashboards.today.salesTotal
- **快取**:60 秒 TTL,並行限制 8 個 Firebase get
- **失敗處理**:單日讀取失敗該日跳過,不阻擋整體
- **作廢排除**:加總時自動跳過 status=void/cancelled/refunded 的訂單

### 重整與輪詢
- **Firebase onValue**:`dashboards/` 根節點訂閱,任何店資料變動即時更新
- **更新時間 ticker**:每秒更新一次「即時連線中 · HH:mm:ss」
- **本週/本月**:30 秒檢查一次快取,超過 60 秒 TTL 重撈

---

## 5. 權限與登入

### 登入機制
- Firebase Auth Google 登入(Popup)
- 不開放註冊,所有帳號必須由管理員手動加入 `staff/{uid}`

### 權限規則
```js
// 看板登入後檢查:
const snapshot = await get(ref(db, `staff/${uid}`));
const role = snapshot.val()?.role;
// role 必須是 'admin' 或 'staff' 才放行
```

### 錯誤處理
| 情境 | 顯示 |
|---|---|
| 未登入 | 顯示登入畫面,Google 按鈕 |
| 登入彈窗被擋 | 「瀏覽器封鎖了登入彈窗」 |
| 帳號不在白名單 | 顯示登入 email + UID,提示聯絡管理員,提供「登出此帳號」按鈕 |
| 讀 staff/{uid} 失敗 | 顯示「權限檢查失敗」+ 錯誤訊息,提示檢查 Firebase 規則 |
| Firebase 讀 dashboards/ 失敗 | 主畫面顯示「連線失敗 + 錯誤訊息」 |

### 必要的 Firebase 安全規則
```json
{
  "rules": {
    "dashboards":     { ".read": "auth != null" },
    "sessionHistory": { ".read": "auth != null" },
    "staff": {
      "$uid": {
        ".read": "$uid === auth.uid"
      }
    }
  }
}
```

---

## 6. Firebase 資料來源

### Firebase 專案
- 專案 ID:`webpos-1f626`(與 POS 共用同一專案)
- Database URL:`https://webpos-1f626-default-rtdb.asia-southeast1.firebasedatabase.app`

### 即時節點(POS dashboard-publish.js 寫入)

#### `dashboards/{storeId}/heartbeat`
```json
{
  "storeName": "一店",
  "lastSeenAt": "2026-05-15T07:13:42.000Z"
}
```

#### `dashboards/{storeId}/today`
```json
{
  "date": "2026-05-15",
  "salesTotal": 12350,
  "salesFromOrders": 11500,
  "orderCount": 23,
  "avgTicket": 500,
  "payments": {
    "現金": { "amount": 8000, "count": 15 },
    "信用卡": { "amount": 3500, "count": 8 }
  },
  "voided": {
    "amount": 75,
    "count": 1,
    "byType": { "void": 75, "cancelled": 0, "refunded": 0 }
  },
  "delivery": { "panda": 500, "uber": 350, "total": 850 }
}
```

**⚠️ 重要欄位命名**:異常欄位名稱固定為 `voided`(不是 `abnormal`)。POS 端 `dashboard-publish.js` 必須寫 `voided`。2026-05-12~13 曾發生欄位名不一致導致看板異常單永遠顯示 0,已於 2026-05-15 還原。

#### `dashboards/{storeId}/session`
```json
{
  "staffId": "alice",
  "startedAt": "2026-05-15T06:00:00.000Z",
  "openingCash": 2000,
  "currentCash": 10000
}
```

#### `dashboards/{storeId}/businessHours`
- 各店營業時段設定
- 看板讀取後用於 BD(營業日)計算

### 歷史節點(看板讀取)

#### `sessionHistory/{storeId}/{BD}/{sessionId}`
- 每個結束班次的完整資料
- BD = YYYY-MM-DD(營業日,跨日營業視為同一 BD)
- 看板用於:本週/本月累計、4 種歷史報表
- 保留 90 天(POS 端結束班次時自動清理)

### 不寫入 Firebase
- 看板**從不寫**任何資料到 Firebase(除了 auth)
- 唯讀架構,完全被動觀察

---

## 7. 歷史報表

### 報表 Modal Step 1:條件設定
- **日期區間**:最多 60 BD,有快捷按鈕(今天/昨天/過去 7/30/60 天)
- **店鋪選擇**:多選 checkbox,預設全選
- **報表類型**:
  1. **營業彙總** — 每店每日 + 跨店總計(營業額、訂單數、客單價、付款方式)
  2. **班次明細** — 含現金差額(開班、結班、應收、差額、備註、人員)
  3. **訂單明細** — 含品項、選項、備註
  4. **異常單** — 拒單 + 折扣單
- **列印紙寬**:58 mm / 80 mm

### 報表 Modal Step 2:預覽 + 動作
- iframe 預覽完整報表
- 3 個動作:返回修改條件、匯出 CSV、列印

### 報表生成流程
```
loadHistory(db, storeIds, dateFrom, dateTo)
  └─ 各店逐 BD 撈 sessionHistory/{sid}/{BD}(限制 8 個並行)
  └─ 整理成 { stores: [{storeId, storeName, sessions, orders, days}], rejectedOrders, discountOrders }

對應 builder:
  buildSummaryReport(data)     → { title, subtitle, sections, footer }
  buildSessionReport(data)
  buildOrderDetailReport(data)
  buildAnomalyReport(data)

previewReport(report, paperWidthMm) → HTML 字串(iframe srcdoc)
printReport(report, {paperWidth})   → 走 print-bridge → HTTP 或 browser fallback

CSV:
  summaryToCSV(data) / sessionsToCSV / ordersToCSV / anomalyToCSV
  exportCSV(rows, filename)
```

### BD 與營業時間
- 區間用 BD 切,不用自然日
- 從 `dashboards/{storeId}/businessHours` 讀各店營業時間
- 若該店未上傳,用 fallback `{ openTime: '14:00', closeTime: '03:00' }`
- 公休日不會產生 BD

### CSV 編碼
- 含 UTF-8 BOM(`\uFEFF`),Excel 開啟中文正常
- 含逗號、引號、換行的欄位自動加雙引號跳脫

---

## 8. 列印功能

### 列印架構
看板的列印**走與 POS 完全相同的橋接**(`js/print-bridge.js`):
1. 嘗試 HTTP 127.0.0.1:8080(若該裝置上有跑 sunmi-pos-v2 APK)
2. Fallback 到 `window.print()`

### 為什麼用同一個橋接?
- 老闆可能用 Sunmi T2(店裡那台)或自己的 iPad / Mac 看看板
- 在 Sunmi T2 上:能直接出 80 mm 熱感
- 在 iPad / Mac:走系統列印對話框,選任何印表機

### Receipt 模式
- 看板列印**僅支援 receipt 模式**(不出標籤、不出廚房單)
- 報表透過 `buildReportPayload` 把 sections 攤平成 items 偽裝成訂單
- APK 端不需要修改,照原本 receipt 邏輯印即可

### 紙寬切換
- 58 mm:預設,適合手感熱感印表機
- 80 mm:Sunmi T2 內建
- 透過 `@page { size: Xmm auto }` + `payload.receiptPaperWidth` 雙重通知

---

## 9. 檔案結構

```
pos-dashboard/
├── README.md                # 本檔
├── index.html               # 看板主頁面(HTML + 全部 CSS + 主 JS module)
└── js/
    ├── biz-day.js           # BD(營業日)工具,必須與 POS 端 js/core/biz-day.js 邏輯一致
    ├── history-loader.js    # 從 Firebase sessionHistory 撈歷史並彙總
    ├── print-bridge.js      # 三層列印橋接偵測(與 POS 端共享邏輯)
    └── print-service-dashboard.js   # 看板專用列印服務(receipt 模式)
```

### 為什麼 index.html 包山包海?
- 看板功能單純(唯讀觀察),沒必要拆多檔
- CSS 放 `<style>` 內,變更容易
- 主 JS 放 `<script type="module">` 內,直接 import 4 個 helper
- 維護成本低,Firebase 連線、UI 渲染、報表 Modal 邏輯都集中

---

## 10. 日常維運

### 開通新店
- **無需在看板任何地方設定**
- POS 端設定好 `storeId` 並開啟 → 30 秒內自動出現在看板

### 開通新使用者
1. 使用者用 Google 登入(被擋,複製 UID)
2. 管理員在 Firebase Console `staff/{uid}` 新增節點 `{email, name, role: "admin"|"staff"}`
3. 使用者重整 → 通過

### 老闆操作快取入口
- **隱藏設定觸發**:**5 秒內快點 header 5 下**(POS 端有,看板暫無,若需可從 POS 端 dashboard-publish.js 移植)

### 報表匯出
1. 點右上「📑 歷史報表」
2. 設定日期、店鋪、類型、紙寬
3. 「產生報表」→ 預覽
4. 三選一:返回修改 / 匯出 CSV / 列印

### 看板自身升級
- 改完直接 commit 推到 main
- GitHub Pages 1~2 分鐘部署完成
- 使用者 Ctrl+F5 重整即可(無 PWA 快取需處理)

---

## 11. 故障排除

| 症狀 | 可能原因 | 排除步驟 |
|---|---|---|
| 「尚無店鋪資料」 | POS 端沒寫到 dashboards/ | 1. 確認 POS 端 storeId 已設定 2. POS 端 Chrome Console 看 dashboard-publish 有沒有報錯 3. Firebase Console 看 dashboards/ 節點有沒有新增 |
| 異常單金額顯示 0(但 POS 端有作廢單) | POS 與看板欄位名不一致 | 看本檔「Firebase 資料來源」段的 ⚠️ 重要欄位命名 |
| 本週/本月顯示「載入中...」太久 | sessionHistory 撈失敗或太多 | 1. F12 Console 看是不是 Firebase permission denied 2. 確認 sessionHistory 規則允許 auth read |
| 顯示「連線失敗」 | Firebase Auth 或網路問題 | 1. 重新登入 2. 換網路試試 3. Firebase Console 看 quota 有沒有超 |
| 「您沒有看板權限」 | UID 不在白名單 | 管理員到 Firebase Console 加 staff/{uid} 節點 |
| 報表列印走系統對話框 | 該裝置沒裝 sunmi-pos-v2 APK | 正常行為,iPad/Mac 本來就沒 APK |
| 報表預覽 iframe 空白 | builder 拋錯 | F12 Console 看紅字,通常是某店 sessionHistory 資料格式異常 |
| CSV 開啟亂碼 | Excel 沒讀 UTF-8 BOM | 重新匯出,確認檔名 `.csv`(不要 `.txt`);若仍亂碼用 Google Sheet 開 |

### 日誌
- Chrome Console 看所有 console.warn / error
- Firebase Console:
  - Authentication 查最近登入
  - Database → Usage 查讀取 quota
  - Database → Data 直接看節點內容

---

## 12. 與 POS 端的依賴關係

### 共用 Firebase 專案
- 同一個 `webpos-1f626`
- 看板**唯讀**,POS 端**讀寫**

### 必須一致的邏輯
| 看板檔案 | POS 對應檔案 | 維護規則 |
|---|---|---|
| `js/biz-day.js` | `js/core/biz-day.js` | **邏輯必須完全一致**,改一邊必須改另一邊 |
| `js/print-bridge.js` | `js/modules/print-bridge.js` | 可獨立改,但若改 API 規格(/ping、/print/*)必須同步 |
| Firebase 欄位讀取 | POS dashboard-publish.js 欄位寫入 | **欄位名必須一致**(voided / abnormal 教訓) |

### 欄位命名規約(v20260614 新增)
- 改任何 Firebase 寫入欄位前,必須 grep 看板 repo 確認讀取碼
- 改完必須同 commit 同步兩邊(POS + 看板)
- 寫入 POS 端 `aiREADME最新進度.md` 的「v20260614 欄位命名規約」段落

---

## 13. 開發守則

> 維護看板的工程師,動手前必須先了解 POS 端的設計,因為兩者深度耦合。

1. **看板永遠唯讀** — 不可寫入 Firebase 任何節點(除了 auth)
2. **欄位讀取對齊 POS** — 修改任何欄位讀取前,先 grep POS 端 dashboard-publish.js 確認寫入名稱
3. **BD 邏輯雙邊同步** — `js/biz-day.js` 改了必須同步改 POS 端 `js/core/biz-day.js`
4. **權限白名單管理** — 新加管理員必須說明該人員權限範圍與聯絡方式
5. **列印走橋接** — 看板列印 fallback 邏輯與 POS 完全相同,改了必須測試 Sunmi/iPad/Mac 三環境
6. **離線預警閾值** — 修改 `ONLINE_THRESHOLD` 或 `ALERT_SESSION_HOURS` 必須先評估誤報率
7. **快取 TTL** — 修改 `WEEK_MONTH_TTL_MS` 必須評估 Firebase 讀取量(影響 quota)
8. **CSV 編碼必含 BOM** — 否則 Excel 中文亂碼
9. **報表 builder 對應 CSV** — 4 種報表必須同時更新對應 CSV 函式
10. **GitHub Pages 部署** — 直接 commit main 即可,無 PWA 快取需處理

---

## 14. 版本歷史

| 版本 | 日期 | 重點 |
|---|---|---|
| v20260613 | 2026-05-13 | BD 60 BD 歷史報表、各店 businessHours、外送 $X 顯示、UI 文字「淨營業額→營業額」「作廢→異常」「最後心跳→最後更新」 |
| v20260608 | 2026-05-xx | 多店架構確立、staff 權限白名單、歷史報表 Modal(4 種類型) |

**詳細變更紀錄請見對應 commit message 與 POS 端 `aiREADME已完成紀錄.md`**(看板側未獨立維護完整 changelog)。

---

## 聯絡與支援

- 看板 Repo:https://github.com/lcym346-byte/pos-dashboard
- POS Repo:https://github.com/lcym346-byte/2237-1
- POS 範本 Repo:https://github.com/jess0937588151-hue/2234

如遇問題,請於 Repo Issues 開啟議題,並附上:
- 瀏覽器 Console 錯誤訊息
- Firebase Console 對應節點截圖
- 看板顯示異常的店家 storeId 與時間點

