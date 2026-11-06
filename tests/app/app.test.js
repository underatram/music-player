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

test('bulk editing sets the artist and track count for every song, row by row is just number and title', { skip }, async () => {
  const file = path.join(music, 'Violet Hours/Afterglow/02 Soft Focus.mp3');
  const before = await readDetails(file);
  const bulk = (artist, total) => `document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true}));await w(150);
    await editRow($('.row[data-track]'));
    const r={artist:field('Artist').value,rowBoxes:[...$$('.editor-rows .editor-row')[0].querySelectorAll('input')].map(b=>b.getAttribute('aria-label'))};
    type(field('Artist'),'${artist}');type(field('Tracks in Album'),'${total}');
    await save();return r`;
  const seen = await page(bulk('Someone Else', '9'));
  assert.strictEqual(seen.artist, 'Violet Hours');
  assert.deepStrictEqual(seen.rowBoxes, ['Track', 'Title']);
  const changed = await readDetails(file);
  assert.deepStrictEqual([changed.artist, changed.trackTotal, changed.title, changed.track], ['Someone Else', '9', before.title, before.track]);
  await page(bulk('Violet Hours', before.trackTotal));
  const restored = await readDetails(file);
  assert.deepStrictEqual([restored.artist, restored.trackTotal], ['Violet Hours', before.trackTotal]);
});

test('going song by song shows the number and title, with the rest a click away', { skip }, async () => {
  const seen = await page(`await editRow($$('.row[data-track]')[1]);
    const shown=(l)=>field(l).checkVisibility();
    const r={track:shown('Track'),title:shown('Title'),artist:shown('Artist'),cover:$('.editor-cover').checkVisibility(),first:$('.editor-field input').getAttribute('aria-label')};
    $('.editor-more summary').click();await w(100);
    r.artistAfter=shown('Artist');r.coverAfter=$('.editor-cover').checkVisibility();
    [...$$('.editor-buttons button')].find(b=>b.textContent==='Close').click();await until(()=>!$('.editor'));
    return r`);
  assert.deepStrictEqual(seen, { track: true, title: true, artist: false, cover: false, first: 'Track', artistAfter: true, coverAfter: true });
});

test('album pages number their songs', { skip }, async () => {
  const seen = await page(`const rows=$$('.row[data-track]');
    const r={head:$('.list-head .column').textContent,numbers:rows.map(x=>x.querySelector('.row-track').textContent)};
    $('.list-head .column').click();await w(200);$('.list-head .column').click();await w(200);
    r.reversed=$$('.row[data-track] .row-track').map(x=>x.textContent);
    $('.list-head .column').click();await w(200);
    return r`);
  assert.strictEqual(seen.head, '#');
  assert.deepStrictEqual(seen.numbers, ['1', '2'], 'Strip All Data took the third song off this album');
  assert.deepStrictEqual(seen.reversed, ['2', '1']);
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

test('playlists go across in order, and follow renames and deletions', { skip }, async () => {
  const titlesOf = (name) => {
    const { lists, tracks } = ipodDatabase();
    const found = lists.find((l) => l.name === name);
    return found && found.paths.map((p) => tracks.find((t) => t.path === p).title);
  };
  const sync = (expected) => page(`$('.device-name').click();await w(300);$('.sync-button').click();
    await until(()=>$$('.notice').some(n=>/${expected}/.test(n.innerText)),30000);await w(500);
    return lines()`);

  await page(`const list=UserData.playlists.find(p=>p.name==='Trip');
    UserData.addToPlaylist(list.id,Library.tracks.filter(t=>t.title==='Soft Focus'||t.title==='Low Tide 2'));
    UserData.setPlaylistOrder(list.id,list.songs.map(Library.byKey).filter(Boolean).reverse())`);
  await sync('changed 1 playlist');
  const sent = titlesOf('Trip');
  assert(sent && sent.length >= 1, 'the playlist isn\'t on the iPod');
  const inApp = await page(`return UserData.playlists.find(p=>p.name==='Trip').songs.map(k=>Library.byKey(k)).filter(Boolean).filter(t=>/\\.mp3$/i.test(t.path)).map(t=>t.title)`);
  assert.deepStrictEqual(sent, inApp, 'order differs');

  const again = await page(`$('.device-name').click();await w(300);return {lines:lines(),button:$('.sync-button').textContent}`);
  assert.strictEqual(again.button, 'Up to Date', 'an unchanged playlist shouldn\'t need sending again');

  await page(`const list=UserData.playlists.find(p=>p.name==='Trip');UserData.renamePlaylist(list.id,'Road Trip')`);
  await sync('changed 2 playlists');
  assert.strictEqual(titlesOf('Trip'), undefined, 'the old name stayed');
  assert.deepStrictEqual(titlesOf('Road Trip'), inApp);

  const smartBefore = ipodDatabase().lists.filter((l) => l.smart).length;
  assert.strictEqual(smartBefore, 1, 'the fake iPod should have a smart playlist');
  const songsBefore = ipodDatabase().tracks.length;
  await page(`const list=UserData.playlists.find(p=>p.name==='Road Trip');UserData.deletePlaylist(list.id)`);
  await sync('changed 1 playlist');
  assert.strictEqual(titlesOf('Road Trip'), undefined);
  assert.strictEqual(ipodDatabase().tracks.length, songsBefore, 'deleting a playlist must not remove songs');
  assert.strictEqual(ipodDatabase().lists.filter((l) => l.smart).length, smartBefore);
});

test('with the music drive gone, the iPod can\'t be synced', { skip }, async () => {
  const hidden = `${music}-gone`;
  const songsBefore = ipodDatabase().tracks.length;
  fs.renameSync(music, hidden);
  try {
    const seen = await page(`await until(()=>document.documentElement.classList.contains('drive-missing'),8000);
      $('.device-name').click();await w(300);
      return {button:Boolean($('.sync-button')),text:$('.ipod-section')&&$('.ipod-section').textContent}`);
    assert.strictEqual(seen.button, false);
    assert.match(seen.text, /Connect your music drive/);
    assert.strictEqual(ipodDatabase().tracks.length, songsBefore);
  } finally {
    fs.renameSync(hidden, music);
  }
  await page(`await until(()=>!document.documentElement.classList.contains('drive-missing'),8000);await w(500)`);
});

test('play counts and the iPod ledger survive a restart', { skip }, async () => {
  await page('UserData.flush()');
  await stopApp();
  await startApp();
  const seen = await page(`const t=Library.tracks.find(x=>x.title==='First Light 2'||x.title==='Stepped');return {favourite:UserData.isFavourite(t),plays:UserData.plays(t),title:t.title,remembered:UserData.ipodPlaylists.length}`);
  assert.deepStrictEqual([seen.favourite, seen.plays, seen.remembered], [true, 1, 0], seen.title);
});

test('an album with two discs has a heading for each, and one that stays in view', { skip }, async () => {
  for (const disc of [1, 2]) {
    for (let i = 1; i <= 20; i++) {
      addSong(`Big Band/Box Set/Disc ${disc}`, `${String(i).padStart(2, '0')} S${disc}-${i}.mp3`, { title: `S${disc}-${i}`, artist: 'Big Band', album: 'Box Set', track: String(i), frames: 100, extra: [['TPOS', A.utf16(`${disc}/2`)]] });
    }
  }
  const seen = await page(`Player.audio.muted=true;
    $('#manage-library').click();await w(100);$$('.menu-item').find(b=>b.textContent.includes('Scan')).click();await until(()=>Library.tracks.some(t=>t.title==='S2-20'));await w(300);
    await openAlbum('Box Set');
    const box=$('#scroller');
    const stuck=()=>{const s=$('.disc-sticky');return s.hidden?null:s.querySelector('h2').textContent};
    const r={meta:$('.meta').textContent,top:stuck(),first:$('.rows .disc-head h2').textContent,detail:$('.rows .disc-head .disc-detail').textContent};
    const rowH=$('.row[data-track]').offsetHeight;
    box.scrollTop=$('.rows').offsetTop+rowH*8;await until(()=>stuck()==='Disc 1',3000).catch(()=>{});r.inOne=stuck();
    box.scrollTop=box.scrollHeight;await until(()=>stuck()==='Disc 2',3000).catch(()=>{});r.inTwo=stuck();
    const lastRow=()=>$$('.row[data-track]').find(x=>x.querySelector('.row-title').textContent==='S2-20');
    await until(lastRow,5000);
    r.lastNumber=$$('.row[data-track] .row-track').pop().textContent;
    lastRow().click();await w(300);
    r.clicked=Player.track.title;
    $('.disc-sticky .page-link').click();await w(300);
    r.played=Player.track.title;
    Player.audio.pause();
    box.scrollTop=0;await w(100);
    $$('.list-head .column').find(c=>c.textContent==='Title').click();await w(200);
    r.sortedHeads=$$('.disc-head').length;r.sortedMeta=$('.meta').textContent;
    await openAlbum('Harbour Lights');
    r.singleHeads=$$('.disc-head').length;r.singleMeta=$('.meta').textContent;
    await openAlbum('Box Set');
    r.reopenedHeads=$$('.rows .disc-head').length>0;r.reopenedSort=$$('.list-head .column').some(c=>/[▲▼]/.test(c.textContent));
    return r`);
  assert.match(seen.meta, /2 discs · 40 songs/);
  assert.strictEqual(seen.top, null, 'nothing floats until the first heading has scrolled away');
  assert.strictEqual(seen.first, 'Disc 1');
  assert.match(seen.detail, /^20 songs/);
  assert.strictEqual(seen.inOne, 'Disc 1');
  assert.strictEqual(seen.inTwo, 'Disc 2');
  assert.strictEqual(seen.lastNumber, '20');
  assert.strictEqual(seen.clicked, 'S2-20', 'a click plays the song under it, despite the headings');
  assert.strictEqual(seen.played, 'S2-1');
  assert.strictEqual(seen.sortedHeads, 0);
  assert.doesNotMatch(seen.sortedMeta, /disc/);
  assert.strictEqual(seen.singleHeads, 0);
  assert.doesNotMatch(seen.singleMeta, /disc/);
  assert.strictEqual(seen.reopenedHeads, true, 'a sort on one album must not hide the next album\'s headings');
  assert.strictEqual(seen.reopenedSort, false);
});

test('the play bar has its own window buttons, and maximise toggles', { skip }, async () => {
  const seen = await page(`const max=$('.window-maximise');const r={shown:!$('.window-controls').hidden,count:$$('.window-button').length};
    max.click();await until(()=>max.getAttribute('aria-label')==='Restore',5000).catch(()=>{});r.after=max.getAttribute('aria-label');
    max.click();await until(()=>max.getAttribute('aria-label')==='Maximise',5000).catch(()=>{});r.back=max.getAttribute('aria-label');
    return r`);
  assert.deepStrictEqual(seen, { shown: true, count: 3, after: 'Restore', back: 'Maximise' });
});
