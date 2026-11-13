const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the actual main-process handlers and preload bridge without starting the app.
function desktopSave(result) {
  const handlers = new Map(), dialogs = [], writes = [];
  const parent = {}, sender = {};
  const downloads = path.resolve('downloads');
  const electron = {
    app: {
      isPackaged: false,
      setName() {}, setPath() {}, on() {},
      getPath: () => downloads,
      commandLine: { appendSwitch() {} },
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then() {} }),
    },
    BrowserWindow: { fromWebContents: (contents) => {
      assert.equal(contents, sender);
      return parent;
    } },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showSaveDialog: async (window, options) => {
      assert.equal(window, parent);
      dialogs.push(options);
      return result;
    } },
  };
  const fileSystem = {
    existsSync: () => false,
    promises: { writeFile: async (file, data) => { writes.push({ file, data }); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), {
    __dirname, process, Buffer,
    require: (name) => name === 'electron' ? electron : name === 'fs' ? fileSystem : require(name),
  });
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, api) => {
        assert.equal(name, 'desktop');
        bridge = api;
      } },
      ipcRenderer: { invoke: (channel, ...args) => handlers.get(channel)({ sender }, ...args) },
    }),
  });
  return { bridge, dialogs, writes, downloads };
}

test('Markdown ZIP opens the native picker and preserves binary data through the preload bridge', async () => {
  const selected = path.resolve('chosen', 'article.zip');
  const { bridge, dialogs, writes, downloads } = desktopSave({ canceled: false, filePath: selected });
  const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80]);
  assert.equal(await bridge.saveFile('article.zip', bytes.buffer), selected);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].defaultPath, path.join(downloads, 'article.zip'));
  assert.equal(dialogs[0].filters[0].extensions[0], 'zip');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].file, selected);
  assert.deepEqual(writes[0].data, Buffer.from(bytes));
});

test('canceling the ZIP picker writes no file', async () => {
  const { bridge, dialogs, writes } = desktopSave({ canceled: true });
  assert.equal(await bridge.saveFile('article.zip', new ArrayBuffer(0)), null);
  assert.equal(dialogs.length, 1);
  assert.equal(writes.length, 0);
});

test('the reader ZIP reaches the selected desktop path through saveAs and the preload bridge', async () => {
  const reader = fs.readFileSync(path.join(__dirname, '..', 'textfold', 'web', 'reader.js'), 'utf8');
  const zipCode = reader.slice(reader.indexOf('  function zipFiles('), reader.indexOf('  async function markdownZip('));
  const saveCode = reader.slice(reader.indexOf('  async function saveAs('), reader.indexOf('  // while a file is made'));
  const selected = path.resolve('chosen', 'article.zip');
  const { bridge, dialogs, writes } = desktopSave({ canceled: false, filePath: selected });
  const { zipFiles, saveAs } = vm.runInNewContext(`${zipCode}\n${saveCode}\n({ zipFiles, saveAs })`, {
    window: { desktop: bridge }, TextEncoder, Blob,
  });
  const zip = zipFiles(new Map([
    ['source-Full-CN.md', '# 中文\n\n![图](img/image.png)'],
    ['img/image.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])],
  ]));
  const expected = Buffer.from(await zip.arrayBuffer());
  assert.equal(await saveAs('article.zip', () => zip, 'application/zip'), selected);
  assert.equal(dialogs.length, 1);
  assert.equal(writes[0].file, selected);
  assert.deepEqual(writes[0].data, expected);
  assert.equal(writes[0].data.readUInt32LE(0), 0x04034b50);
});

test('text and image exports still use the native picker', async () => {
  for (const extension of ['html', 'md', 'json', 'png', 'jpg', 'gif', 'webp', 'svg']) {
    const selected = path.resolve(`article.${extension}`);
    const { bridge, dialogs, writes } = desktopSave({ canceled: false, filePath: selected });
    assert.equal(await bridge.saveFile(`article.${extension}`, 'content'), selected);
    assert.equal(dialogs[0].filters[0].extensions[0], extension);
    assert.equal(writes[0].data, 'content');
  }
});
