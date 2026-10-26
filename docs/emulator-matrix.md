# 模擬器矩陣（雷電）— 產品與技術設計

> 分支：`feat/emulator-matrix`（國際版 client_matrix、國內版 client_matrix_cn 各一條），**不合併 main**。
> 狀態：第一期（含 TikTok / Facebook App 自動點讚、評論）開發中，待 Windows 實機測試。

## 1. 為什麼要做

現在的矩陣號全部跑在「指紋瀏覽器內核 + CDP」上，只能操作各平台的**網頁版**。
有些事情網頁版做不到或限制多：

- 抖音、小紅書、快手很多功能只有 App 有（部分發布選項、App 專屬入口）。
- TikTok 網頁版近期常回 403、「Something went wrong」。
- 有些用戶本來就習慣「一排手機」的工作方式。

目標：**在同一個 NoobClaw 桌面端裡，讓一個矩陣號可以選擇跑在「瀏覽器」或「雷電模擬器」上**。
AI 生成內容、帳號人設、任務排程、計費這些既有能力全部共用，只把「執行端」換成手機 App。

## 2. 目標用戶與場景

| 用戶 | 場景 |
|---|---|
| 矩陣工作室 / 代營運 | 一台 Windows 電腦開 4～10 個雷電實例，每個實例對應一個帳號，批量發布 AI 生成的影片和圖文 |
| 出海 TikTok 創作者 | 需要 App 才有的發布選項；每個帳號依所在地區設定網路 |
| 現有矩陣用戶 | 網頁版不穩定的平台，改用模擬器跑同一個任務 |

## 3. 範圍與界線

### 做
- 雷電模擬器實例的**建立、啟動、關閉、刪除、顯示視窗**（只用官方 `ldconsole` 命令列）。
- **帳號 ↔ 實例一對一綁定**：一個矩陣號固定用一個實例，登入狀態留在實例裡。
- **每個實例設定自己的代理**：沿用帳號現有的 `proxy` 欄位與連通性校驗。
- **App 自動化控制層**：ADB + uiautomator2 的手機端服務（u2.jar，MIT），由 Node 直接講 JSON-RPC，不需要 Python。
- **手機版 driver**：沿用「服務端下發腳本、客戶端執行」的熱更新模式，給腳本一個手機版 ctx（找元素、點擊、滑動、輸入、推檔案、開關 App）。
- **開發工具**：一鍵匯出目前畫面的結構（XML）和截圖，方便寫 driver。

### 不做（產品紅線）
- **不改裝置識別資訊**：不呼叫 `ldconsole modify` 的 `--imei / --imsi / --androidid / --mac / --manufacturer / --model / --pnumber / --simserial`，只調解析度、CPU、記憶體。
- **不做模擬器偵測規避、不做「防關聯」設計**，文案也不能用「防封、防關聯」。代理的產品定位是「依帳號所在地區設定網路」。
- **不做帳號批量註冊、簡訊驗證繞過**。
- 互動類（按讚、留言）沿用網頁版既有的人性化節奏與每日上限，不會因為換到模擬器而放寬；手機版只做點讚、評論，不做關注、私訊。
- 雷電只從官方域名下載官方安裝程式，由用戶在安裝視窗自己點安裝（不靜默安裝、不改包）。

### 要誠實告訴用戶的風險
- 模擬器 + 機房 IP 在平台眼中屬於高風險環境，帳號被限流、要求驗證的機率比真手機高。
- 第一期代理用的是 Android 系統 HTTP 代理，**部分 App 或 UDP（QUIC）流量可能不走代理**；第二期改成模擬器內的 VPN 型代理 App 才能保證全部流量走代理。

## 4. 平台

- 只支援 **Windows**（雷電沒有 Mac 版）。非 Windows 系統上所有模擬器入口隱藏或顯示「僅 Windows 支援」。
- 雷電版本：雷電 9 / 14（官方命令列文件適用這兩版）。
- 雷電由用戶自行安裝，我們**不打包、不散布**雷電。

## 5. 架構

```
渲染層 (React)
  MatrixEmulatorPanel  ──ipcInvoke('emu:*')──▶  sidecar-server
  建號彈窗：執行端 = 瀏覽器 / 雷電模擬器

主進程 / sidecar  src/main/libs/matrix/emulator/
  ldplayer.ts        偵測安裝路徑、ldconsole 封裝（list2/add/remove/launch/quit/modify/installapp/runapp/killapp/sortWnd）
  adb.ts             adb 封裝（devices/shell/push/forward/reverse/connect/等開機）
  u2Agent.ts         推 u2.jar → app_process 啟動 → adb forward → JSON-RPC（dump/截圖/點擊/滑動/按鍵）
  u2Jar.ts           u2.jar 下載與校驗（多來源，國內可走自家鏡像）
  uiTree.ts          解析 dumpWindowHierarchy 的 XML → 節點陣列 + 簡易選擇器（text / resourceId / desc / class）
  emulatorProxy.ts   本機 HTTP CONNECT 中轉（上游 http/https/socks5，可帶帳密）+ adb reverse + 系統代理設定
  emulatorPool.ts    帳號 ↔ 實例綁定、啟動/健康檢查/重連、忙碌鎖、phoneCmd 路由
  phoneDriverCtx.ts  手機版 driver 的 ctx；腳本來源 = /api/matrix/drivers 中 phone_* 鍵，開發時可用本機覆寫目錄
```

### 5.1 資料模型（`MatrixAccount` 擴充）

```ts
runtime?: 'browser' | 'emulator';   // 缺省 = 'browser'（存量號不受影響）
emulator?: {
  provider: 'ldplayer';
  instanceName: string;   // nc_<accountId>，建立後固定
  index?: number;         // ldconsole 索引（每次啟動前用 list2 依名稱重新查，不信任快取）
  serial?: string;        // 最近一次的 adb serial（emulator-5554 / 127.0.0.1:5555）
  packages?: string[];    // 這個實例要用到的 App（例如 com.zhiliaoapp.musically）
};
```

### 5.2 啟動流程（`ensureRunning(accountId)`）

1. 依 `instanceName` 用 `list2` 找索引；找不到就 `add --name` 建一個，並 `modify` 解析度 720×1280、2 核、2 GB。
2. 沒在跑就 `launch`，輪詢 `adb devices` + `getprop sys.boot_completed`，最多 180 秒。
3. 套用代理（見 5.3）。
4. 推 u2.jar（md5 相同就跳過）→ `app_process` 啟動 → `adb forward tcp:<本機埠> tcp:9008` → `/ping` 回 `pong` 即就緒。
5. 回傳 session（serial、本機埠），之後 `phoneCmd` 都走這個 session；JSON-RPC 失敗自動重啟 u2 一次。

### 5.3 代理

- 帳號沒設代理：清掉系統代理（`settings put global http_proxy :0`）。
- 有代理：本機起一個 HTTP 代理中轉（支援 CONNECT），上游依帳號設定走 http/https/socks5（可帶帳密）。
  - 用 `adb reverse tcp:<裝置埠> tcp:<本機中轉埠>`，模擬器裡設 `http_proxy=127.0.0.1:<裝置埠>`。好處是不用管雷電的虛擬網路拓撲。
- 第二期：模擬器內裝 VPN 型代理 App（sing-box 類），所有流量含 UDP 都走代理。

### 5.4 手機版 driver ctx（第一期指令）

| 指令 | 說明 |
|---|---|
| `dump()` | 目前畫面節點陣列（text、resourceId、desc、class、bounds、clickable…） |
| `find(sel)` / `findAll(sel)` | 選擇器：`{ text, textContains, resourceId, desc, descContains, className, clickable }` |
| `waitFor(sel, ms)` | 等元素出現 |
| `tap(x, y)` / `click(sel)` | 點座標 / 點元素中心 |
| `longPress(x, y, ms)` | 長按 |
| `swipe(x1, y1, x2, y2, ms)` | 滑動 |
| `back()` / `home()` | 系統鍵 |
| `inputText(text)` | 輸入到目前焦點欄位（中文可用） |
| `appStart(pkg)` / `appStop(pkg)` / `appCurrent()` | App 控制 |
| `pushMedia(localPath)` | 推影片/圖片到 `/sdcard/DCIM/NoobClaw/` 並觸發媒體掃描，回傳裝置路徑 |
| `screenshot()` | base64 JPEG |
| `sleep(ms)` / `log(msg)` | 工具 |

## 6. 分期

| 期 | 內容 | 驗收 |
|---|---|---|
| **一（本分支）** | 雷電一鍵下載安裝、實例管理與多開（按記憶體限並發）、帳號綁定、代理中轉、u2 控制層、手機 driver ctx、模擬器面板、畫面匯出；**互動任務接上模擬器號：TikTok / Facebook App 自動點讚 + AI 評論**（沿用網頁版配額、節奏、計費、去重） | 在 Windows 上：一鍵裝雷電 → 建 3 個 TikTok 帳號 → 全部建立實例 / 全部啟動 → 手動登入 → 跑互動任務，點讚和評論數達標 |
| 二 | VPN 型代理 App、更多平台與任務類型 | 依第一期實測結果排 |
| 三 | 雲手機（有開放 ADB 的業者）接入、Mac 用 Google 官方模擬器 | — |

## 7. 第三方授權

- uiautomator2 / android-uiautomator-server（u2.jar）：MIT，需在「關於」頁附上授權聲明。
- 雷電：用戶自行安裝，我們只呼叫其官方命令列。

## 8. 第一期補充（互動任務）

- `engageRunner` 遇到 `runtime='emulator'` 的帳號：不起指紋內核，改占多開名額 → 啟動該號實例 → 跑手機版劇本 `phone_<平台>_engage`（後端 `/api/matrix/drivers` 下發優先，客戶端內置版兜底，源碼在 `docs/emulator-drivers/`，改完跑 `node scripts/gen-emulator-drivers.js`）。
- 劇本拿到的 ctx 與網頁版剧本相同（配額、`aiCall('comment_composer')`、`chargeAction`、`engageHistory`、`report`），設備操作在 `ctx.phone`。
- 任務自己開的實例跑完就關，釋放記憶體給排隊的帳號；用戶原本開著的不動。
- App 撞登錄頁 → 帳號標「需登錄」，提示到模擬器面板手動登錄。
- 只有模擬器帳號時不需要裝指紋瀏覽器內核（建號、手動運行、定時調度都放行）。
