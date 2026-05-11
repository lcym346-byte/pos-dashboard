/* ============================================================
   js/modules/print-bridge.js  v2026-05-08-floating-toggle
   列印橋接偵測 + 路由
   修正：
   - /ping 回應若帶 token 自動同步到 localStorage
   - unauthorized 時 detectPrinters(true) 重抓 token 再重試
   - log 框改為右下角小圓鈕 🔍，點擊展開/收起
   ============================================================ */

const HTTP_HOST = '127.0.0.1';
const HTTP_PORT = 8080;
const HTTP_BASE = `http://${HTTP_HOST}:${HTTP_PORT}`;
const PING_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 8000;
const TOKEN_STORAGE_KEY = 'pos_apk_api_token';

let _cache = null;
let _detecting = null;
let _lastError = '';

if (typeof window !== 'undefined') {
  window.__printLog = window.__printLog || [];
}

// ============================================================
// log 框 UI：右下角小圓鈕，點擊切換展開
// ============================================================
function ensureLogUI() {
  if (typeof document === 'undefined' || !document.body) return null;
  let panel = document.getElementById('__printLogBox');
  let btn = document.getElementById('__printLogBtn');
  if (panel && btn) return { panel, btn };

  // 浮動圓鈕
  if (!btn) {
    btn = document.createElement('div');
    btn.id = '__printLogBtn';
    btn.textContent = '🔍';
    btn.title = '除錯日誌';
    btn.style.cssText = [
      'position:fixed','right:12px','bottom:12px','width:40px','height:40px',
      'border-radius:50%','background:#ff8c00','color:#fff',
      'font-size:20px','line-height:40px','text-align:center','cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.3)','z-index:2147483647',
      'user-select:none'
    ].join(';');
    btn.onclick = () => {
      const p = document.getElementById('__printLogBox');
      if (!p) return;
      p.style.display = (p.style.display === 'none' || !p.style.display) ? 'block' : 'none';
    };
    document.body.appendChild(btn);
  }

  // log 面板（預設隱藏）
  if (!panel) {
    panel = document.createElement('div');
    panel.id = '__printLogBox';
    panel.style.cssText = [
      'position:fixed','right:12px','bottom:60px','width:360px','max-height:60vh',
      'overflow:auto','background:#ff8c00','color:#fff','font:11px/1.4 monospace',
      'padding:6px 8px','border:2px solid #b35c00','border-radius:6px',
      'z-index:2147483646','box-shadow:0 2px 8px rgba(0,0,0,.3)',
      'white-space:pre-wrap','word-break:break-all','display:none'
    ].join(';');
    const close = document.createElement('div');
    close.textContent = '✕';
    close.style.cssText = 'position:absolute;top:2px;right:6px;cursor:pointer;font-weight:700;font-size:14px';
    close.onclick = () => { panel.style.display = 'none'; };
    const title = document.createElement('div');
    title.textContent = '[print-bridge log]';
    title.style.cssText = 'font-weight:700;margin-bottom:4px';
    const body = document.createElement('div');
    body.id = '__printLogBody';
    panel.appendChild(close);
    panel.appendChild(title);
    panel.appendChild(body);
    document.body.appendChild(panel);
  }

  return { panel, btn };
}

function plog(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = '[' + ts + '] ' + msg;
  try { console.log('[print-bridge]', msg); } catch(e) {}
  try {
    if (typeof window !== 'undefined') {
      if (!window.__printLog) window.__printLog = [];
      window.__printLog.push(line);
      if (window.__printLog.length > 200) window.__printLog.shift();
    }
  } catch(e) {}
  try {
    const ui = ensureLogUI();
    if (!ui) return;
    const body = document.getElementById('__printLogBody');
    if (!body) return;
    const div = document.createElement('div');
    div.textContent = line;
    body.appendChild(div);
    while (body.childNodes.length > 50) body.removeChild(body.firstChild);
    ui.panel.scrollTop = ui.panel.scrollHeight;
  } catch(e) {}
}

function getToken() {
  try { return localStorage.getItem(TOKEN_STORAGE_KEY) || ''; }
  catch(e) { return ''; }
}

export function setApiToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, String(token));
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
    plog('setApiToken len=' + (token ? String(token).length : 0));
  } catch(e) {}
}

export function getApiToken() {
  return getToken();
}

export function getLastError() {
  return _lastError;
}

function fetchOnce(url, opts, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + ms + 'ms')), ms);
    fetch(url, opts)
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

function fetchWithTimeout(url, opts, ms) {
  return fetchOnce(url, opts, ms).catch(async (e) => {
    const msg = String(e && e.message || e);
    // 只對「socket 死掉」類型的錯誤重試一次（瀏覽器拿到死的 keep-alive 連線）
    if (msg.indexOf('Failed to fetch') >= 0 || msg.indexOf('NetworkError') >= 0) {
      plog('fetchWithTimeout: ' + msg + ' → retry once after 250ms');
      await new Promise(res => setTimeout(res, 250));
      return fetchOnce(url, opts, ms);
    }
    throw e;
  });
}


export async function detectPrinters(force = false) {
  if (!force && _cache && (Date.now() - _cache.timestamp) < CACHE_TTL_MS) {
    plog('detectPrinters: cache hit mode=' + _cache.mode);
    return _cache;
  }
  if (_detecting) {
    plog('detectPrinters: already running, awaiting');
    return _detecting;
  }

  _detecting = (async () => {
    plog('detectPrinters: START force=' + force + ' url=' + HTTP_BASE + '/ping');
    let result;

    try {
      const t0 = Date.now();
      const resp = await fetchWithTimeout(`${HTTP_BASE}/ping`, { method: 'GET' }, PING_TIMEOUT_MS);
      const dt = Date.now() - t0;
      plog('detectPrinters: /ping status=' + (resp ? resp.status : 'null') + ' time=' + dt + 'ms');
      if (resp && resp.ok) {
        const text = await resp.text();
        plog('detectPrinters: /ping body=' + text.slice(0, 200));
        let j = {};
        try { j = JSON.parse(text); } catch(e) { plog('detectPrinters: JSON.parse failed'); }
        const data = (j && j.data) ? j.data : (j || {});

        if (data.token && typeof data.token === 'string' && data.token.length > 0) {
          const cur = getToken();
          if (cur !== data.token) {
            plog('detectPrinters: token changed, sync from /ping (old len=' + cur.length + ' new len=' + data.token.length + ')');
            setApiToken(data.token);
          } else {
            plog('detectPrinters: token matches /ping');
          }
        }

        result = {
          mode: 'http',
          sunmi: !!(data.sunmiConnected || data.sunmi),
          bluetooth: !!(data.bluetoothConnected || data.bluetooth),
          network: !!(data.networkConnected || data.network),
          paperOut: !!data.paperOut,
          coverOpen: !!data.coverOpen,
          overheat: !!data.overheat,
          version: data.version || '',
          error: ''
        };
        plog('detectPrinters: HTTP OK mode=http sunmi=' + result.sunmi
          + ' bt=' + result.bluetooth + ' net=' + result.network
          + ' ver=' + result.version);
      }
    } catch (e) {
      _lastError = 'detect http failed: ' + (e && e.message || e);
      plog('detectPrinters EXCEPTION: ' + _lastError);
    }

    if (!result && typeof window !== 'undefined' && window.SunmiPrinter
        && typeof window.SunmiPrinter.isPrinterReady === 'function') {
      try {
        result = {
          mode: 'webview',
          sunmi: !!window.SunmiPrinter.isPrinterReady(),
          bluetooth: typeof window.SunmiPrinter.isBtPrinterConnected === 'function'
                       ? !!window.SunmiPrinter.isBtPrinterConnected() : false,
          network: typeof window.SunmiPrinter.isNetPrinterConnected === 'function'
                       ? !!window.SunmiPrinter.isNetPrinterConnected() : false,
          version: 'webview',
          error: ''
        };
        plog('detectPrinters: WebView mode sunmi=' + result.sunmi);
      } catch (e) {
        plog('detectPrinters webview EXCEPTION: ' + (e && e.message || e));
      }
    }

    if (!result) {
      result = {
        mode: 'browser',
        sunmi: null,
        bluetooth: null,
        network: null,
        version: '',
        error: ''
      };
      plog('detectPrinters: fallback to BROWSER mode (HTTP/WebView 都失敗)');
    }

    result.timestamp = Date.now();
    _cache = result;
    plog('detectPrinters: DONE final mode=' + result.mode);
    return result;
  })();

  try {
    return await _detecting;
  } finally {
    _detecting = null;
  }
}

export function getCachedDetect() {
  return _cache;
}

export function clearDetectCache() {
  _cache = null;
}

function buildHeaders(extra) {
  const h = Object.assign({}, extra || {});
  const tk = getToken();
  if (tk) h['X-API-Token'] = tk;
  return h;
}

function isUnauthorized(status, respText) {
  if (status === 401 || status === 403) return true;
  if (typeof respText === 'string' && respText.toLowerCase().indexOf('unauthorized') >= 0) return true;
  return false;
}

async function _doHttpPrint(target, utf8Bytes) {
  const t0 = Date.now();
  const resp = await fetchWithTimeout(`${HTTP_BASE}/print/${target}`, {
    method: 'POST',
    headers: buildHeaders({ 'Content-Type': 'application/octet-stream' }),
    body: utf8Bytes
  }, 8000);
  const dt = Date.now() - t0;
  const respText = await resp.text();
  plog('httpPrint ← ' + target + ' status=' + resp.status + ' time=' + dt + 'ms');
  plog('httpPrint resp=' + respText.slice(0, 200));
  return { status: resp.status, text: respText };
}
async function _doHttpOpenDrawer() {
  const url = `${HTTP_BASE}/drawer/open`;
  const t0 = Date.now();
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: buildHeaders({ 'Content-Type': 'application/json' }),
    body: '{}'
  }, 5000);
  const dt = Date.now() - t0;
  const text = await resp.text();
  plog('httpOpenDrawer ← status=' + resp.status + ' time=' + dt + 'ms');
  plog('httpOpenDrawer resp=' + text.slice(0, 200));
  return { status: resp.status, text };
}

export async function httpPrint(target, body) {
  const jsonStr = JSON.stringify(body || {});
  const utf8Bytes = new TextEncoder().encode(jsonStr);
  plog('httpPrint → ' + target + ' url=' + HTTP_BASE + '/print/' + target + ' bodyLen=' + utf8Bytes.length);
  plog('httpPrint body head=' + jsonStr.slice(0, 200));

  var idx = jsonStr.indexOf('"shopName"');
  if (idx >= 0) {
    var sample = jsonStr.slice(idx, idx + 80);
    plog('httpPrint shopName slice=' + sample);
    var cps = '';
    for (var k = 0; k < Math.min(sample.length, 40); k++) cps += sample.charCodeAt(k).toString(16) + ' ';
    plog('httpPrint shopName codepoints(first40)=' + cps);
  }

  plog('httpPrint hasToken=' + (getApiToken() ? 'yes' : 'no'));

  try {
    let r = await _doHttpPrint(target, utf8Bytes);

    if (isUnauthorized(r.status, r.text)) {
      plog('httpPrint unauthorized, refresh token via /ping and retry once');
      clearDetectCache();
      await detectPrinters(true);
      const newTk = getToken();
      if (newTk) {
        plog('httpPrint retry with new token len=' + newTk.length);
        r = await _doHttpPrint(target, utf8Bytes);
      } else {
        plog('httpPrint no token after refresh, giving up');
      }
    }

    let j = {};
    try { j = JSON.parse(r.text); } catch(e) {}
    if (!j.ok) _lastError = 'httpPrint ' + target + ' failed: ' + (j.error || r.text || 'unknown');
    return { ok: !!j.ok, error: j.error || '' };
  } catch (e) {
    const msg = String(e && e.message || e);
    plog('httpPrint EXC ' + target + ' ' + msg);
    _lastError = 'httpPrint ' + target + ' exception: ' + msg;
    return { ok: false, error: msg };
  }
}

export async function httpOpenDrawer() {
  async function attempt(label) {
    plog('httpOpenDrawer ' + label + ' → url=' + HTTP_BASE + '/drawer/open');
    plog('httpOpenDrawer ' + label + ' hasToken=' + (getToken() ? 'yes' : 'no'));

    let r = await _doHttpOpenDrawer();

    if (isUnauthorized(r.status, r.text)) {
      plog('httpOpenDrawer ' + label + ' unauthorized, refresh token via /ping and retry once');
      clearDetectCache();
      await detectPrinters(true);
      const newTk = getToken();
      if (newTk) {
        plog('httpOpenDrawer ' + label + ' retry with new token len=' + newTk.length);
        r = await _doHttpOpenDrawer();
      } else {
        plog('httpOpenDrawer ' + label + ' no token after refresh, giving up');
      }
    }

    let j = {};
    try { j = JSON.parse(r.text); } catch(e) {}
    if (!j.ok) _lastError = 'httpOpenDrawer failed: ' + (j.error || r.text || 'unknown');
    return { ok: !!j.ok, error: j.error || '' };
  }

  // 第一次嘗試
  try {
    return await attempt('try1');
  } catch (e) {
    const msg = String(e && e.message || e);
    plog('httpOpenDrawer try1 EXCEPTION: ' + msg + ' → retry after 200ms');
    // socket 死掉時，等 200ms 讓瀏覽器釋放舊連線，再重試一次
    await new Promise(res => setTimeout(res, 200));
    try {
      return await attempt('try2');
    } catch (e2) {
      const msg2 = String(e2 && e2.message || e2);
      _lastError = 'httpOpenDrawer exception: ' + msg2;
      plog('httpOpenDrawer try2 EXCEPTION: ' + msg2);
      return { ok: false, error: msg2 };
    }
  }
}

export function browserPrintHtml(html) {
  plog('browserPrintHtml: fallback to system print dialog');
  return new Promise(resolve => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();

    const fire = () => {
      try { iframe.contentWindow.focus(); iframe.contentWindow.print(); }
      catch(e) { console.warn('browserPrint failed:', e); }
      setTimeout(() => {
        try { document.body.removeChild(iframe); } catch(e){}
        resolve(true);
      }, 1500);
    };
    iframe.onload = fire;
    setTimeout(fire, 600);
  });
}

export function getBridgeInfo() {
  return { host: HTTP_HOST, port: HTTP_PORT, base: HTTP_BASE, hasToken: !!getToken() };
}
