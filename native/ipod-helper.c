// Changes what's on an iPod using libgpod.
//
// Usage: ipod-helper sync <mount>
// Reads one instruction per line from stdin, with fields separated by 0x1f:
//   R <path on the iPod>        remove this song
//   A <the FIELD_ values below> add this song
//   U <path on the iPod> <track> <of> <disc> <of>  correct a song's numbers
// Removals happen first, to free the space. The database is saved before any
// removed file is deleted, so an interruption can't leave it listing missing songs.
// Reports progress on stdout, one line at a time:
//   X <count>            this many songs have been removed
//   P <index>            song number <index> of the additions was copied
//   F <index> <message>  that song couldn't be copied
//   W                    saving the database
//   D <removed> <added> <updated>  finished
//   E <message>          stopped because of a problem
// SIGTERM stops after the current song and still saves what's been done.
#include <errno.h>
#include <glib/gstdio.h>
#include <gpod/itdb.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  FIELD_PATH, FIELD_TITLE, FIELD_ARTIST, FIELD_ALBUM_ARTIST, FIELD_ALBUM, FIELD_GENRE,
  FIELD_YEAR, FIELD_TRACK, FIELD_TRACK_TOTAL, FIELD_DISC, FIELD_DISC_TOTAL, FIELD_COMPILATION, FIELD_SECONDS, FIELD_BYTES,
  FIELD_COVER, FIELD_COUNT,
};

#define SAVE_EVERY_SONGS 200
#define SAMPLE_RATE 44100
#define BYTES_PER_KILOBIT 125

static volatile sig_atomic_t stopping = 0;

static void stop_soon(int signal_number) {
  (void)signal_number;
  stopping = 1;
}

static gchar *text_or_null(const char *value) {
  return value[0] ? g_strdup(value) : NULL;
}

static Itdb_Track *make_track(gchar **fields) {
  Itdb_Track *track = itdb_track_new();
  double seconds = g_ascii_strtod(fields[FIELD_SECONDS], NULL);
  gint64 bytes = g_ascii_strtoll(fields[FIELD_BYTES], NULL, 10);

  track->title = text_or_null(fields[FIELD_TITLE]);
  track->artist = text_or_null(fields[FIELD_ARTIST]);
  track->albumartist = text_or_null(fields[FIELD_ALBUM_ARTIST]);
  track->album = text_or_null(fields[FIELD_ALBUM]);
  track->genre = text_or_null(fields[FIELD_GENRE]);
  track->filetype = g_strdup("MPEG audio file");
  track->year = atoi(fields[FIELD_YEAR]);
  track->track_nr = atoi(fields[FIELD_TRACK]);
  track->tracks = atoi(fields[FIELD_TRACK_TOTAL]);
  track->cd_nr = atoi(fields[FIELD_DISC]);
  track->cds = atoi(fields[FIELD_DISC_TOTAL]);
  track->compilation = atoi(fields[FIELD_COMPILATION]) ? 1 : 0;
  track->size = (guint32)bytes;
  track->tracklen = (gint32)(seconds * 1000);
  track->bitrate = seconds > 0 ? (gint32)(bytes / seconds / BYTES_PER_KILOBIT) : 0;
  track->samplerate = SAMPLE_RATE;
  track->mediatype = ITDB_MEDIATYPE_AUDIO;
  track->time_added = time(NULL);
  return track;
}

static int save(Itdb_iTunesDB *db) {
  GError *error = NULL;
  printf("W\n");
  if (itdb_write(db, &error)) return 1;
  printf("E Couldn't save: %s\n", error ? error->message : "unknown");
  return 0;
}

// Takes the songs out of the database and saves it, then deletes their files.
static int remove_songs(Itdb_iTunesDB *db, GPtrArray *paths, int *removed) {
  GHashTable *by_path = g_hash_table_new(g_str_hash, g_str_equal);
  for (GList *l = db->tracks; l; l = l->next) {
    Itdb_Track *track = l->data;
    if (track->ipod_path) g_hash_table_insert(by_path, track->ipod_path, track);
  }

  GPtrArray *files = g_ptr_array_new_with_free_func(g_free);
  GPtrArray *found = g_ptr_array_new();
  for (guint i = 0; i < paths->len; i++) {
    Itdb_Track *track = g_hash_table_lookup(by_path, g_ptr_array_index(paths, i));
    if (track) g_ptr_array_add(found, track);
  }
  g_hash_table_destroy(by_path);

  for (guint i = 0; i < found->len; i++) {
    Itdb_Track *track = g_ptr_array_index(found, i);
    gchar *file = itdb_filename_on_ipod(track);
    if (file) g_ptr_array_add(files, file);
    for (GList *p = db->playlists; p; p = p->next) {
      Itdb_Playlist *playlist = p->data;
      if (itdb_playlist_contains_track(playlist, track)) itdb_playlist_remove_track(playlist, track);
    }
    itdb_track_remove(track);
    *removed += 1;
  }
  g_ptr_array_free(found, TRUE);
  printf("X %d\n", *removed);

  int saved = *removed == 0 || save(db);
  if (saved) {
    for (guint i = 0; i < files->len; i++) g_unlink(g_ptr_array_index(files, i));
  }
  g_ptr_array_free(files, TRUE);
  return saved;
}

enum { UPDATE_PATH, UPDATE_TRACK, UPDATE_TRACK_TOTAL, UPDATE_DISC, UPDATE_DISC_TOTAL, UPDATE_COUNT };

// Numbers only: the song's file and everything else about it stay as they are.
static int update_songs(Itdb_iTunesDB *db, GPtrArray *updates) {
  GHashTable *by_path = g_hash_table_new(g_str_hash, g_str_equal);
  for (GList *l = db->tracks; l; l = l->next) {
    Itdb_Track *track = l->data;
    if (track->ipod_path) g_hash_table_insert(by_path, track->ipod_path, track);
  }
  int updated = 0;
  for (guint i = 0; i < updates->len; i++) {
    gchar **fields = g_ptr_array_index(updates, i);
    Itdb_Track *track = g_hash_table_lookup(by_path, fields[UPDATE_PATH]);
    if (!track) continue;
    track->track_nr = atoi(fields[UPDATE_TRACK]);
    track->tracks = atoi(fields[UPDATE_TRACK_TOTAL]);
    track->cd_nr = atoi(fields[UPDATE_DISC]);
    track->cds = atoi(fields[UPDATE_DISC_TOTAL]);
    updated++;
  }
  g_hash_table_destroy(by_path);
  return updated;
}

int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "sync") != 0) {
    printf("E usage: ipod-helper sync <mount>\n");
    return 2;
  }
  setvbuf(stdout, NULL, _IOLBF, 0);
  signal(SIGTERM, stop_soon);

  GError *error = NULL;
  Itdb_iTunesDB *db = itdb_parse(argv[2], &error);
  if (!db) {
    printf("E Couldn't read the iPod: %s\n", error ? error->message : "unknown");
    return 1;
  }
  const Itdb_IpodInfo *info = itdb_device_get_ipod_info(db->device);
  if (!info || info->ipod_generation == ITDB_IPOD_GENERATION_UNKNOWN) {
    // Writing without knowing the model would leave a database the iPod rejects.
    printf("E The iPod's model is unknown, so writing to it isn't safe.\n");
    return 3;
  }
  Itdb_Playlist *everything = itdb_playlist_mpl(db);
  if (!everything) {
    printf("E The iPod's music list is damaged.\n");
    return 4;
  }

  // Everything is read before anything changes, so a bad instruction stops the sync early.
  GPtrArray *removals = g_ptr_array_new_with_free_func(g_free);
  GPtrArray *additions = g_ptr_array_new_with_free_func((GDestroyNotify)g_strfreev);
  GPtrArray *updates = g_ptr_array_new_with_free_func((GDestroyNotify)g_strfreev);
  char *line = NULL;
  size_t capacity = 0;
  while (getline(&line, &capacity, stdin) > 0) {
    line[strcspn(line, "\n")] = 0;
    if (line[0] == 'R' && line[1] == '\x1f') {
      g_ptr_array_add(removals, g_strdup(line + 2));
    } else if (line[0] == 'A' && line[1] == '\x1f') {
      gchar **fields = g_strsplit(line + 2, "\x1f", FIELD_COUNT);
      if (g_strv_length(fields) != FIELD_COUNT) {
        printf("E Bad song details: %s\n", fields[0] ? fields[0] : "");
        return 6;
      }
      g_ptr_array_add(additions, fields);
    } else if (line[0] == 'U' && line[1] == '\x1f') {
      gchar **fields = g_strsplit(line + 2, "\x1f", UPDATE_COUNT);
      if (g_strv_length(fields) != UPDATE_COUNT) {
        printf("E Bad song numbers: %s\n", fields[0] ? fields[0] : "");
        return 6;
      }
      g_ptr_array_add(updates, fields);
    } else if (line[0]) {
      printf("E Bad instruction\n");
      return 6;
    }
  }
  free(line);

  int removed = 0;
  if (!remove_songs(db, removals, &removed)) return 5;

  int updated = update_songs(db, updates);
  int added = 0;
  int unsaved = updated;
  for (guint index = 0; index < additions->len && !stopping; index++) {
    gchar **fields = g_ptr_array_index(additions, index);
    Itdb_Track *track = make_track(fields);
    itdb_track_add(db, track, -1);
    GError *copy_error = NULL;
    if (!itdb_cp_track_to_ipod(track, fields[FIELD_PATH], &copy_error)) {
      printf("F %u %s\n", index, copy_error ? copy_error->message : "Couldn't copy");
      g_clear_error(&copy_error);
      itdb_track_remove(track);
      continue;
    }
    itdb_playlist_add_track(everything, track, -1);
    // A cover that won't load shouldn't stop the song being added.
    if (fields[FIELD_COVER][0]) itdb_track_set_thumbnails(track, fields[FIELD_COVER]);
    added++;
    unsaved++;
    printf("P %u\n", index);
    if (unsaved >= SAVE_EVERY_SONGS) {
      if (!save(db)) return 5;
      unsaved = 0;
    }
  }
  if (unsaved && !save(db)) return 5;

  printf("D %d %d %d\n", removed, added, updated);
  itdb_free(db);
  return 0;
}
