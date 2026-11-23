// TextFold as an app: the same local server and the same reader, in one window.
//
// The packaged app carries its own Python (payload/python, from python-build-standalone) and the code (payload/app:
// textfold/, its web/ inside). It starts the server on a free port of 127.0.0.1, with the reader's papers kept in the app's data
// folder (TEXTFOLD_DATA), and points its window at it. Settings and keys stay where the server always keeps them,
// ~/.textfold. Pages on other sites open in the system browser, where the reader is already signed in.
// Run from the repository without a payload (`npm start`), it uses the python3 on the PATH (python on Windows) and the
// repository itself. textfold:// links open a document of the library in the window (links.js).
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Transform } = require('stream');
const { StringDecoder } = require('string_decoder');
const links = require('./links');

const WIN = process.platform === 'win32';
const PAYLOAD = app.isPackaged ? path.join(process.resourcesPath, 'payload') : path.join(__dirname, 'payload');
const BUNDLED = WIN ? path.join(PAYLOAD, 'python', 'python.exe') : path.join(PAYLOAD, 'python', 'bin', 'python3');
const PACKED = fs.existsSync(BUNDLED);
const PYTHON = PACKED ? BUNDLED : WIN ? 'python' : 'python3';
const CODE = PACKED ? path.join(PAYLOAD, 'app') : path.join(__dirname, '..');

let server = null;
let win = null;
let tray = null;
let quitting = false;
let base = null;      // the server's address, once it answers
let waiting = null;   // a link that came before that: the last one, opened then

// the data folder (papers/, out/, server.log), the one `python3 -m textfold serve` keeps too (store.app_data()): on a Mac
// ~/Library/Application Support/TextFold, Electron's own; on Windows %LOCALAPPDATA%\TextFold, where Electron's is Roaming
// (TEXTFOLD_DATA, as for the server: another folder, for a test run)
app.setName('TextFold');
if (process.env.TEXTFOLD_DATA) app.setPath('userData', path.resolve(process.env.TEXTFOLD_DATA));
else if (WIN) app.setPath('userData', path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'TextFold'));
// The window's HTTP cache, at most 32 MB (and no large file in it): what it loads comes from the server on this computer,
// read from the same disk, and under Chromium's own limit, a share of the free space, it kept a second copy of each PDF
// and picture opened, 200 MB and more. A page still reuses what it loaded (Blink's memory cache).
app.commandLine.appendSwitch('disk-cache-size', String(32 * 2 ** 20));
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  showWindow();
  follow(links.fromArgv(argv));
});

// ── textfold:// links ────────────────────────────────────────────────
// Another program (an editor's plugin) opens a document of the library at a paragraph, a section, a note or a level. The packaged
// app is the scheme's handler: declared for macOS in package.json (build.protocols), and claimed here, which Windows
// needs, since its installer registers no scheme. A copy run from the code never claims it, so no build of the
// repository takes the installed app's links.
if (app.isPackaged) app.setAsDefaultProtocolClient('textfold');
// macOS hands a link to the app, before it is ready when the link starts it; Windows and Linux start the app with the
// link on its command line, and a second instance hands its own to this one (second-instance, above)
app.on('open-url', (e, url) => { e.preventDefault(); follow(url); });
follow(links.fromArgv(process.argv));

function follow(link) {
  const parts = link && links.parse(link);
  if (!parts) return;
  waiting = parts;
  if (base && win && !win.isDestroyed()) go();
}
// the reader's page of a document not in the library opens the landing without a word: the app says which it was
const MISSING = { en: 'This link names a document that is not in the library.', zh: '这个链接指向的文档不在列表中。',
  'zh-Hant': '這個連結指向的文件不在列表中。', ja: 'このリンクが指す文書は一覧にありません。', ko: '이 링크가 가리키는 문서는 목록에 없습니다.',
  es: 'Este enlace remite a un documento que no está en la biblioteca.', fr: 'Ce lien renvoie à un document qui n’est pas dans la bibliothèque.',
  de: 'Dieser Link führt zu einem Dokument, das nicht in der Bibliothek ist.', pt: 'Este link leva a um documento que não está na biblioteca.',
  it: 'Questo link rimanda a un documento che non è nella libreria.', ru: 'Эта ссылка ведёт к документу, которого нет в библиотеке.',
  hi: 'यह लिंक जिस दस्तावेज़ का है, वह सूची में नहीं है।' };
async function inLibrary(id) {
  try {
    const r = await fetch(`${base}/api/papers`);
    return !r.ok || (await r.json()).some((p) => p.id === id);
  } catch {
    return true;   // (no answer: the page says so itself)
  }
}
async function go() {
  const parts = waiting;
  waiting = null;
  const window = win;
  showWindow();
  const found = await inLibrary(parts.paper);
  if (window.isDestroyed()) return;
  if (!found) {
    await dialog.showMessageBox(window, { type: 'info', message: inLocale(MISSING), detail: parts.paper });
    if (!window.isDestroyed()) window.loadURL(`${base}/`);
    return;
  }
  const url = links.readerUrl(base, parts);
  // the reader reads #u=, #s=, #n= and #level= as it opens, so a link into the page already open opens it again
  if (url.includes('#') && window.webContents.getURL().split('#')[0] === url.split('#')[0]) {
    window.webContents.executeJavaScript(`history.replaceState(null, '', ${JSON.stringify(url)}); location.reload();`).catch(() => {
      if (!window.isDestroyed()) window.loadURL(url);
    });
  } else {
    window.loadURL(url);
  }
}

// a free port from a quiet base, so a server run by hand on 3017 is never in the way
function freePort(start = 31917) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(freePort(start + 1)));
    probe.once('listening', () => probe.close(() => resolve(start)));
    probe.listen(start, '127.0.0.1');
  });
}

// The library moved in Settings is copied when the server starts, before it answers (textfold/storage_settings.py): the
// server says so, the window too, and the wait lasts as long as the copy (a large library on a slow disk takes minutes)
let copying = false;
const COPYING = { en: 'Copying your library to its new folder. This happens once.', zh: '正在把文献库复制到新文件夹，只有这一次。',
  'zh-Hant': '正在把文獻庫複製到新資料夾，只有這一次。', ja: 'ライブラリを新しいフォルダにコピーしています。これは一度だけです。',
  ko: '라이브러리를 새 폴더로 복사하고 있습니다. 한 번만 합니다.', es: 'Copiando tu biblioteca a su nueva carpeta. Solo esta vez.',
  fr: 'Copie de votre bibliothèque dans son nouveau dossier. Cela n’arrive qu’une fois.', de: 'Deine Bibliothek wird in ihren neuen Ordner kopiert. Das geschieht nur einmal.',
  pt: 'Copiando sua biblioteca para a nova pasta. Isso acontece só uma vez.', it: 'Copia della tua libreria nella nuova cartella. Succede una volta sola.',
  ru: 'Ваша библиотека копируется в новую папку. Это происходит один раз.', hi: 'आपकी लाइब्रेरी नए फ़ोल्डर में कॉपी हो रही है। ऐसा केवल एक बार होता है।' };
function heard(chunk) {
  if (copying || !/copying the library/.test(String(chunk))) return;
  copying = true;
  if (win && !win.isDestroyed()) win.webContents.executeJavaScript(`document.querySelector('.note').textContent = ${JSON.stringify(inLocale(COPYING))}`).catch(() => {});
}

async function waitReady(port, tries = 160) {
  for (let i = 0; i < tries || (copying && server); i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/models`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// the log's lines, each with when it was written (the computer's time, to the second): a report then says when
// what it shows happened, and which start of the app it was
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
function stamped() {
  const text = new StringDecoder('utf8');   // (a character split between two chunks is kept whole)
  let rest = '';
  const lines = (s) => s.map((l) => `${stamp()} ${l}\n`).join('');
  return new Transform({
    transform(chunk, _enc, done) {
      const all = (rest + text.write(chunk)).split('\n');
      rest = all.pop();
      done(null, lines(all));
    },
    flush(done) {
      const last = rest + text.end();
      done(null, last ? lines([last]) : '');
    },
  });
}

function startServer(port) {
  // A GUI app starts with a bare PATH: the usual install places are added so that the server finds node and npx
  // (the ChatGPT bridge) at once; on a Mac it also asks the login shell for the agents' places (textfold/agents.py).
  const home = app.getPath('home');
  const extra = WIN
    ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'), path.join(home, '.local', 'bin')]
    : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin')];
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';   // Windows spells it Path
  const env = {
    ...process.env,
    [key]: [...extra, process.env[key] || (WIN ? '' : '/usr/bin:/bin')].filter(Boolean).join(path.delimiter),
    TEXTFOLD_DATA: app.getPath('userData'),
    TEXTFOLD_RUNTIME_ID: 'desktop',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    // the locale's codepage (cp936 on a Chinese Windows) is otherwise the default for open() and the pipes, and the
    // packages the app ships read files of their own: UTF-8 mode makes the whole process, and the children it starts,
    // read and write UTF-8
    PYTHONUTF8: '1',
  };
  const log = fs.createWriteStream(path.join(app.getPath('userData'), 'server.log'), { flags: 'a' });
  log.write(`${stamp()} TextFold ${app.getVersion()} starts (${process.platform} ${process.arch})\n`);
  // (windowsHide: no console window beside the app's own)
  server = spawn(PYTHON, ['-s', '-u', '-m', 'textfold', 'serve', '--port', String(port)], { cwd: CODE, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.pipe(stamped()).pipe(log, { end: false });
  server.stderr.pipe(stamped()).pipe(log, { end: false });
  server.stdout.on('data', heard);
  server.on('exit', (code) => { server = null; if (code && win && !win.isDestroyed()) win.webContents.send?.('server-exit', code); });
  registerHost(env, log);
}

// The browser's button (extension/) reaches TextFold through its native messaging host, which each start registers
// for this user, with this app's Python, code and library, so that the browser starts this copy of TextFold, wherever
// the app was moved and whichever version it is now (textfold/capture.py: install --app). A copy run from the code
// registers only when asked to (TEXTFOLD_REGISTER_HOST), so that no build of the repository takes the installed app's.
function registerHost(env, log) {
  if (!app.isPackaged && !process.env.TEXTFOLD_REGISTER_HOST) return;
  if (process.execPath.includes('/AppTranslocation/')) return;   // (a Mac's copy of an app not yet moved out of Downloads: gone when it quits)
  const p = spawn(PYTHON, ['-s', '-m', 'textfold', 'capture', 'install', '--app'], { cwd: CODE, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  p.stdout.pipe(stamped()).pipe(log, { end: false });
  p.stderr.pipe(stamped()).pipe(log, { end: false });
  p.on('error', () => {});   // (said in the log; the app itself goes on)
}

async function open() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 720, minHeight: 520, show: true, title: 'TextFold',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1B1915' : '#FAF9F7',   // the start page's ground, dark or light
    autoHideMenuBar: true,   // (Windows: the menu bar shows on Alt)
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.on('close', (event) => {
    if (!tray || quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.loadFile(path.join(__dirname, 'splash.html'));
  // full screen, from View › Toggle Full Screen or the reader's Aa: the page told when it changes (its button's name)
  for (const ev of ['enter-full-screen', 'leave-full-screen']) win.on(ev, () => win.webContents.send('fullscreen', win.isFullScreen()));
  const local = (url) => /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (local(url) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  const port = await freePort();
  if (quitting) return;
  startServer(port);
  const ready = await waitReady(port);
  if (quitting || win.isDestroyed()) return;
  if (!ready) {
    const where = path.join(app.getPath('userData'), 'server.log');
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<pre style="font:14px -apple-system,'Segoe UI',sans-serif;padding:24px;white-space:pre-wrap">TextFold could not start its server.\n\nThe log is in ${where}</pre>`)}`);
    return;
  }
  base = `http://127.0.0.1:${port}`;
  if (waiting) go();
  else win.loadURL(`${base}/`);
}

ipcMain.handle('open-external', (_e, url) => (/^https?:/.test(url) ? shell.openExternal(url) : null));
// a file the reader saves (a page, its notes, a figure's picture): where it goes, they choose in the system's own
// dialog; the path, or null. A page is text, a picture its bytes
const KINDS = { html: 'Web page', md: 'Markdown', zip: 'ZIP archive', json: 'JSON', png: 'PNG image', jpg: 'JPEG image', gif: 'GIF image', webp: 'WebP image', svg: 'SVG image' };
ipcMain.handle('save-file', async (e, name, data) => {
  const ext = path.extname(String(name)).slice(1).toLowerCase();
  if (!KINDS[ext]) return null;
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: path.join(app.getPath('downloads'), path.basename(String(name))),
    filters: [{ name: KINDS[ext], extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, typeof data === 'string' ? data : Buffer.from(data));
  return r.filePath;
});
// the folder the library is to go to, or the library to open (Settings: textfold/storage_settings.py), in the system's
// own dialog: its path, or null
ipcMain.handle('storage:choose-folder', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'TextFold', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0] || null;
});

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('window:fullscreen', (e, on) => {   // on: true or false; nothing: only whether it is
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && typeof on === 'boolean') w.setFullScreen(on);
  return Boolean(w && w.isFullScreen());
});
// a table's words in the system's language (its own variant for Chinese in Taiwan, Hong Kong and Macao), else English
function inLocale(table) {
  const loc = app.getLocale();
  return table[/^zh-(TW|HK|MO)|Hant/i.test(loc) ? 'zh-Hant' : loc.split('-')[0]] || table.en;
}

function showWindow() {
  if (quitting || !win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const iconPath = app.isPackaged ? path.join(process.resourcesPath, 'tray-icon.png')
    : path.join(__dirname, 'build', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return;
  tray = new Tray(icon);
  tray.setToolTip('TextFold');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: inLocale({ en: 'Open TextFold', zh: '打开 TextFold', 'zh-Hant': '開啟 TextFold' }), click: showWindow },
    { label: inLocale({ en: 'Quit TextFold', zh: '退出 TextFold', 'zh-Hant': '結束 TextFold' }), role: 'quit' },
  ]));
  tray.on('double-click', showWindow);
}

// The system's own menu and the project on GitHub.
const REPO = 'https://github.com/chenxiachan/textfold';
function menu() {
  const github = { label: 'TextFold on GitHub', click: () => shell.openExternal(REPO) };
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : [{ role: 'fileMenu' }]),
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    { role: 'help', submenu: [github] },
  ]));
}

app.whenReady().then(() => {
  menu();
  if (WIN) createTray();
  open();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  if (tray) tray.destroy();
  if (server) server.kill();
});
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) open(); });
