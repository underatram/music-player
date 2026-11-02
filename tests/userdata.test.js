// Favourites, play counts and playlists can't be rebuilt, so moving them must not lose them.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadPage, fakeDb } = require('./support/page');

async function setup(saved = null) {
  const written = [];
  const Host = { readData: async () => saved, writeData: (d) => written.push(d), writeDataNow: (d) => written.push(d) };
  const { UserData } = loadPage(['userdata.js'], { Host, DB: fakeDb() });
  await UserData.load();
  return { UserData, written };
}
const song = (key) => ({ key, genreKey: 'rock' });

test('an edit moves a song\'s history and playlist place to its new key', async () => {
  const { UserData } = await setup();
  const old = song('old');
  UserData.setFavourite(old, true);
  UserData.countPlay(old);
  const list = UserData.createPlaylist('Trip');
  UserData.addToPlaylist(list.id, [song('first'), old, song('last')]);

  UserData.moveSong('old', 'new');

  assert.strictEqual(UserData.isFavourite(song('new')), true);
  assert.strictEqual(UserData.plays(song('new')), 1);
  assert.strictEqual(UserData.plays(old), 0);
  assert.deepStrictEqual([...UserData.findPlaylist(list.id).songs], ['first', 'new', 'last']);
});

test('moving onto a song that exists adds the histories together', async () => {
  const { UserData } = await setup();
  const a = song('a');
  const b = song('b');
  UserData.countPlay(a);
  UserData.countPlay(a);
  UserData.countPlay(b);
  UserData.setFavourite(b, true);
  const list = UserData.createPlaylist('Trip');
  UserData.addToPlaylist(list.id, [a, b]);

  UserData.moveSong('a', 'b');

  assert.strictEqual(UserData.plays(b), 3);
  assert.strictEqual(UserData.isFavourite(b), true);
  assert.deepStrictEqual([...UserData.findPlaylist(list.id).songs], ['b'], 'no duplicate in the playlist');
});

test('another copy with the old tags keeps its history too', async () => {
  const { UserData } = await setup();
  const old = song('old');
  UserData.countPlay(old);
  const list = UserData.createPlaylist('Trip');
  UserData.addToPlaylist(list.id, [old]);

  UserData.moveSong('old', 'new', true);

  assert.strictEqual(UserData.plays(old), 1);
  assert.strictEqual(UserData.plays(song('new')), 1);
  assert.deepStrictEqual([...UserData.findPlaylist(list.id).songs], ['old']);
});

test('moving a song to its own key changes nothing', async () => {
  const { UserData } = await setup();
  const a = song('a');
  UserData.countPlay(a);
  UserData.moveSong('a', 'a');
  assert.strictEqual(UserData.plays(a), 1);
});

test('plays from the iPod are never counted twice', async () => {
  const { UserData } = await setup();
  const a = song('a');
  UserData.countPlay(a);
  assert.strictEqual(UserData.addIpodPlays(':f:1.mp3', 'a', 3, 5000), 3);
  assert.strictEqual(UserData.plays(a), 4);
  assert.strictEqual(UserData.addIpodPlays(':f:1.mp3', 'a', 3, 5000), 0, 'bringing back again adds nothing');
  assert.strictEqual(UserData.plays(a), 4);
  assert.strictEqual(UserData.addIpodPlays(':f:1.mp3', 'a', 5, 6000), 2, 'only new plays count');
  assert.strictEqual(UserData.plays(a), 6);
  assert.strictEqual(UserData.ipodPlaysCounted(':f:1.mp3'), 5);
});

test('iPod plays can be stored for a song not in the library', async () => {
  const { UserData } = await setup();
  UserData.addIpodPlays(':f:2.mp3', 'absent', 2, 100);
  assert.strictEqual(UserData.plays(song('absent')), 2);
});

test('the most recent play wins, wherever it happened', async () => {
  const { UserData } = await setup();
  const a = song('a');
  UserData.addIpodPlays(':f:1.mp3', 'a', 1, 5000);
  assert.strictEqual(UserData.lastPlayed(a), 5000);
  UserData.addIpodPlays(':f:1.mp3', 'a', 2, 4000);
  assert.strictEqual(UserData.lastPlayed(a), 5000);
  UserData.addIpodPlays(':f:1.mp3', 'a', 3, 6000);
  assert.strictEqual(UserData.lastPlayed(a), 6000);
});

test('saved data loads back', async () => {
  const { UserData } = await setup({ version: 1, songs: { a: { plays: 7 } }, playlists: [{ id: 'p4', name: 'Old', songs: ['a'] }] });
  assert.strictEqual(UserData.plays(song('a')), 7);
  assert.strictEqual(UserData.createPlaylist('Next').id, 'p5', 'new playlists don\'t reuse an id');
});

test('podcasts and audiobooks default to remembering and skipping', async () => {
  const { UserData } = await setup();
  const podcast = { key: 'p', genreKey: 'podcast' };
  assert.strictEqual(UserData.remembersPosition(podcast), true);
  assert.strictEqual(UserData.skipsShuffle(podcast), true);
  assert.strictEqual(UserData.remembersPosition(song('r')), false);
  UserData.setSkipsShuffle(podcast, false);
  assert.strictEqual(UserData.skipsShuffle(podcast), false);
});
