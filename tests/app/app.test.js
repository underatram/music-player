// Drives the real app in a real window against made-up music and a fake iPod, using
// a separate settings folder. Nothing here can reach a real library or iPod.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const A = require('../support/audio');
const F = require('../support/fake-ipod');
const { readDetails } = require('../../electron/id3');
const Ipod = require('../../electron/ipod');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
const PORT = 9444;
const skip = F.canBuild() ? false : 'libgpod-dev, pkg-config or gcc is missing';

let dir;
let music;
let ipodMount;
let app;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---- Talking to the page ----

async function evaluate(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const reply = await new Promise((resolve) => {
    ws.onmessage = (message) => resolve(JSON.parse(message.data));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
  });
  ws.close();
  if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || 'page error');
  return reply.result.result.value;
}

const HELPERS = `
  const w=(m)=>new Promise(r=>setTimeout(r,m));
  const $=(s)=>document.querySelector(s);
  const $$=(s)=>[...document.querySelectorAll(s)];
  const lines=()=>Object.fromEntries($$('.sync-line').map(l=>[l.children[0].textContent,l.children[1].textContent]));
  const type=(i,v)=>{i.value=v;i.dispatchEvent(new Event('input',{bubbles:true}))};
  const field=(l)=>$$('.editor-field').find(f=>f.firstChild.textContent===l).querySelector('input');
  const until=async(fn,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await fn())return true;await w(100)}throw new Error('timed out waiting: '+fn)};
  const openAlbum=async(n)=>{const a=$('[data-tab=Albums]');if(a.getAttribute('aria-expanded')!=='true'){a.click();await w(200)}$$('.filter').find(f=>f.textContent.trim()===n).click();await w(300)};
  const editRow=async(row)=>{const r=row.getBoundingClientRect();row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+20,clientY:r.top+10}));await w(100);$$('.menu-item').find(b=>b.textContent.includes('Edit ')).click();await until(()=>$('.editor'))};
  const save=async()=>{$('.editor button[type=submit]').click();await until(()=>!$('.editor'));await w(800)};
`;
const page = (body) => evaluate(`(async()=>{${HELPERS}${body}})()`);

// ---- Starting and stopping the app ----

async function startApp() {
  app = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, ROOT], {
    // The app looks for iPods in /run/media/<user>/, so this resolves to a temporary folder.
    env: { ...process.env, USER: `../..${path.join(dir, 'mounts')}`, XDG_CONFIG_HOME: path.join(dir, 'config') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if (await evaluate('typeof Library !== "undefined" && Library.tracks.length > 2')) break;
    } catch {
      // Not listening yet.
    }
    await wait(200);
  }
  await wait(2500);
}

async function stopApp() {
  if (!app) return;
  const closed = new Promise((resolve) => { app.on('close', resolve); });
  app.kill();
  await closed;
  app = null;
}

const addSong = (folder, name, details) => {
  fs.mkdirSync(path.join(music, folder), { recursive: true });
  fs.writeFileSync(path.join(music, folder, name), A.song({ frames: 1000, ...details }));
};
const ipodDatabase = () => Ipod.parseDatabase(fs.readFileSync(path.join(ipodMount, 'iPod_Control', 'iTunes', 'iTunesDB')));

before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-app-test-'));
  music = path.join(dir, 'library', 'Music');
  const maker = F.buildTools(dir);
  ['First Light', 'Soft Focus', 'Halcyon'].forEach((title, i) => addSong('Violet Hours/Afterglow', `0${i + 1} ${title}.mp3`, { title, artist: 'Violet Hours', album: 'Afterglow', track: `${i + 1}/3`, extra: [['APIC', A.apic('image/png', A.TINY_PNG)], ['PRIV', Buffer.from('private-data')]] }));
  addSong('Paper Lanterns/Harbour Lights', '01 Low Tide.mp3', { title: 'Low Tide', artist: 'Paper Lanterns', album: 'Harbour Lights', track: '1' });

  // The fake iPod starts with one song that's not in the library, as if from elsewhere.
  ipodMount = path.join(dir, 'mounts', 'FAKEIPOD');
  F.makeIpod(maker, ipodMount);
  const source = path.join(dir, 'other.mp3');
  fs.writeFileSync(source, A.song({ title: 'Not In Library' }));
  await F.runHelper(ipodMount, [F.addLine(source, { title: 'Not In Library', album: 'Elsewhere', track: 1, trackTotal: 1 })]);

  fs.mkdirSync(path.join(dir, 'config', 'music-player'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'music-player', 'settings.json'), JSON.stringify({ folder: music }));
  await startApp();
});

after(async () => {
  await stopApp();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('the library loads', { skip }, async () => {
  assert.strictEqual(await page('return Library.tracks.length'), 4);
});

test('bulk editing changes the files and keeps history', { skip }, async () => {
  await page(`const t=Library.tracks.find(x=>x.title==='First Light');UserData.setFavourite(t,true);UserData.countPlay(t);const p=UserData.createPlaylist('Trip');UserData.addToPlaylist(p.id,[t]);UserData.flush()`);
  const seen = await page(`await openAlbum('Afterglow');
    document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true}));await w(150);
    await editRow($('.row[data-track]'));
    const r={title:$('.editor .dialog-title').textContent,album:field('Album').value};
    type(field('Album'),'Afterglow Deluxe');type($$('.editor-rows .editor-row')[0].querySelectorAll('input')[1],'First Light 2');
    await save();
    r.heading=$('.heading').textContent;r.rows=$$('.row[data-track] .row-title').map(x=>x.textContent);
    const t=Library.tracks.find(x=>x.title==='First Light 2');
    r.favourite=UserData.isFavourite(t);r.plays=UserData.plays(t);r.inList=UserData.playlists[0].songs.includes(t.key);
    return r`);
  assert.strictEqual(seen.title, 'Edit 3 Songs');
  assert.strictEqual(seen.album, 'Afterglow');
  assert.strictEqual(seen.heading, 'Afterglow Deluxe');
  assert.deepStrictEqual(seen.rows, ['First Light 2', 'Soft Focus', 'Halcyon']);
  assert.deepStrictEqual([seen.favourite, seen.plays, seen.inList], [true, 1, true]);
  const file = path.join(music, 'Violet Hours/Afterglow/01 First Light.mp3');
  const d = await readDetails(file);
  assert.deepStrictEqual([d.title, d.album, d.artist, d.track], ['First Light 2', 'Afterglow Deluxe', 'Violet Hours', '1']);
  assert(fs.readFileSync(file).includes('private-data'), 'a tweak keeps what it wasn\'t asked to change');
});

test('Back and Next save as they go, and the list updates afterwards', { skip }, async () => {
  const seen = await page(`await editRow($$('.row[data-track]')[0]);
    const r={title:$('.editor .dialog-title').textContent};
    type(field('Title'),'Stepped');
    $$('.editor-step')[1].click();await until(()=>field('Title').value==='Soft Focus');
    r.next=$('.editor .dialog-title').textContent;
    type(field('Title'),'Thrown Away');
    [...$$('.editor-buttons button')].find(b=>b.textContent==='Close').click();
    await until(()=>!$('.editor'));await w(1000);
    r.rows=$$('.row[data-track] .row-title').map(x=>x.textContent);
    return r`);
  assert.strictEqual(seen.title, 'Edit Song · 1 of 3');
  assert.strictEqual(seen.next, 'Edit Song · 2 of 3');
  assert.deepStrictEqual(seen.rows, ['Stepped', 'Soft Focus', 'Halcyon'], 'Close discards only the song on screen');
});

test('Strip All Data empties the boxes, and Undo brings them back', { skip }, async () => {
  const seen = await page(`await editRow($$('.row[data-track]')[2]);
    const r={before:field('Title').value};
    [...$$('.editor button')].find(b=>b.textContent==='Strip All Data').click();await w(100);
    r.stripped=field('Title').value;r.save=$('.editor button[type=submit]').textContent;
    [...$$('.editor button')].find(b=>b.textContent==='Undo Strip').click();await w(100);
    r.undone=field('Title').value;
    [...$$('.editor button')].find(b=>b.textContent==='Strip All Data').click();await w(100);
    type(field('Title'),'Clean');
    await save();
    return r`);
  assert.deepStrictEqual(seen, { before: 'Halcyon', stripped: '', save: 'Strip and Save', undone: 'Halcyon' });
  const file = path.join(music, 'Violet Hours/Afterglow/03 Halcyon.mp3');
  const bytes = fs.readFileSync(file);
  assert.strictEqual((await readDetails(file)).title, 'Clean');
  assert(!bytes.includes('private-data'));
  assert(!bytes.includes('image/png'));
});

test('a song being played keeps playing through an edit', { skip }, async () => {
  const seen = await page(`Player.audio.muted=true;await openAlbum('Harbour Lights');
    Player.playList(Library.tracks.filter(x=>x.album==='Harbour Lights'),0);await until(()=>Player.isPlaying);
    Player.audio.currentTime=5;await w(300);
    await editRow($('.row[data-track]'));type(field('Title'),'Low Tide 2');await save();await w(800);
    const r={title:$('#now-title').textContent,playing:Player.isPlaying,time:Player.audio.currentTime,error:Boolean(Player.audio.error)};
    Player.audio.pause();return r`);
  assert.strictEqual(seen.title, 'Low Tide 2');
  assert.strictEqual(seen.playing, true);
  assert.strictEqual(seen.error, false);
  assert(seen.time >= 5, `restarted at ${seen.time}`);
});

test('a scan finds new music without being told', { skip }, async () => {
  addSong('New Band/New Album', '01 New Song.mp3', { title: 'New Song', artist: 'New Band', album: 'New Album', track: '1' });
  const seen = await page(`$('#manage-library').click();await w(100);
    $$('.menu-item').find(b=>b.textContent.includes('Scan')).click();
    await until(()=>$('.notice'));
    const r={notice:$('.notice').innerText};
    $$('.notice button').find(b=>b.textContent==='Show New Music').click();await w(300);
    r.heading=$('.heading').textContent;r.rows=$$('.row[data-track] .row-title').map(x=>x.textContent);return r`);
  assert.match(seen.notice, /1 new album, 1 song/);
  assert.strictEqual(seen.heading, 'New Music');
  assert.deepStrictEqual(seen.rows, ['New Song']);
});

test('the iPod appears with an accurate plan', { skip }, async () => {
  const seen = await page(`await until(()=>$('.device-name'));$('.device-name').click();await w(300);
    return {heading:$('.heading').textContent,rows:$$('.sync-row').length,lines:lines(),button:$('.sync-button').textContent}`);
  assert.strictEqual(seen.heading, 'Test iPod');
  assert.strictEqual(seen.lines.Remove.split(',')[0], '1 song');
  assert.match(seen.lines.Add, /^5 songs/);
  assert.strictEqual(seen.button, 'Sync Now');
});

test('cancelling the confirmation changes nothing on the iPod', { skip }, async () => {
  const database = path.join(ipodMount, 'iPod_Control', 'iTunes', 'iTunesDB');
  const original = A.sha(fs.readFileSync(database));
  const seen = await page(`$('.sync-button').click();await until(()=>$('.dialog'));
    const r={title:$('.dialog-title').textContent};
    $('.dialog .secondary').click();await w(300);r.syncing=Boolean($('.sync-progress'));return r`);
  assert.strictEqual(seen.title, 'Remove 1 song from your iPod?');
  assert.strictEqual(seen.syncing, false);
  assert.strictEqual(A.sha(fs.readFileSync(database)), original);
});

test('a confirmed sync makes the iPod match, with albums in order', { skip }, async () => {
  const seen = await page(`$('.sync-button').click();await until(()=>$('.dialog'));$('.dialog .primary').click();
    await until(()=>$$('.notice').some(n=>n.innerText.startsWith('Sync finished')),60000);await w(500);
    return {notice:$$('.notice')[0].innerText,lines:lines(),button:$('.sync-button').textContent}`);
  assert.match(seen.notice, /Added 5 songs, removed 1 song/);
  assert.strictEqual(seen.button, 'Up to Date');
  const { tracks } = ipodDatabase();
  assert.strictEqual(tracks.length, 5);
  assert(!tracks.some((t) => t.title === 'Not In Library'));
  for (const t of tracks) {
    assert(t.trackTotal >= 1, `${t.title} has no track total`);
    assert(t.discNo >= 1 && t.discTotal >= 1, `${t.title} has no disc numbers`);
    assert(fs.existsSync(path.join(ipodMount, ...t.path.split(':').filter(Boolean))), `${t.title} has no file`);
  }
  assert.strictEqual(tracks.find((t) => t.title === 'Soft Focus').trackTotal, 3);
  assert(fs.existsSync(path.join(dir, 'config', 'music-player', 'ipod-backups')), 'no copy of the old song list was kept');
});

test('unticking something removes only that from the iPod', { skip }, async () => {
  // Tick boxes are grouped by library, so a podcast is the thing that can be unticked alone.
  addSong('Long Story/Show', '01 Episode.mp3', { title: 'Episode', artist: 'Long Story', album: 'The Show', genre: 'Podcast', track: '1' });
  await page(`$('#manage-library').click();await w(100);$$('.menu-item').find(b=>b.textContent.includes('Scan')).click();await until(()=>Library.tracks.length===6);await w(300);$('.device-name').click();await w(300)`);
  await page(`$('.sync-button').click();await until(()=>$$('.notice').some(n=>/Added 1 song/.test(n.innerText)),30000)`);
  assert.strictEqual(ipodDatabase().tracks.length, 6);
  const seen = await page(`$$('.sync-row').find(r=>r.textContent.includes('The Show')).querySelector('input').click();await w(200);
    const r=lines();$('.sync-button').click();await until(()=>$('.dialog'));$('.dialog .primary').click();
    await until(()=>$$('.notice').some(n=>/removed 1 song/.test(n.innerText)),30000);await w(500);
    $$('.sync-row').find(x=>x.textContent.includes('The Show')).querySelector('input').click();await w(100);
    return r`);
  assert.strictEqual(seen.Remove.split(',')[0], '1 song');
  const { tracks } = ipodDatabase();
  assert.strictEqual(tracks.length, 5);
  assert(!tracks.some((t) => t.title === 'Episode'));
});

test('with the music drive gone, the iPod can\'t be synced', { skip }, async () => {
  const hidden = `${music}-gone`;
  fs.renameSync(music, hidden);
  try {
    const seen = await page(`await until(()=>document.documentElement.classList.contains('drive-missing'),8000);
      $('.device-name').click();await w(300);
      return {button:Boolean($('.sync-button')),text:$('.ipod-section')&&$('.ipod-section').textContent}`);
    assert.strictEqual(seen.button, false);
    assert.match(seen.text, /Connect your music drive/);
    assert.strictEqual(ipodDatabase().tracks.length, 5);
  } finally {
    fs.renameSync(hidden, music);
  }
  await page(`await until(()=>!document.documentElement.classList.contains('drive-missing'),8000);await w(500)`);
});

test('play counts and the iPod ledger survive a restart', { skip }, async () => {
  await page('UserData.flush()');
  await stopApp();
  await startApp();
  const seen = await page(`const t=Library.tracks.find(x=>x.title==='First Light 2'||x.title==='Stepped');return {favourite:UserData.isFavourite(t),plays:UserData.plays(t),title:t.title,inList:UserData.playlists[0].songs.includes(t.key)}`);
  assert.deepStrictEqual([seen.favourite, seen.plays, seen.inList], [true, 1, true], seen.title);
});
