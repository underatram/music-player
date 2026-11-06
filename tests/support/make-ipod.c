// Creates an empty fake iPod in a folder, for tests. Usage: make-ipod <folder>
#include <gpod/itdb.h>
#include <stdio.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  GError *error = NULL;
  // A 160 GB iPod classic, the model this has been tried on for real.
  if (!itdb_init_ipod(argv[1], "C297", "Test iPod", &error)) {
    printf("%s\n", error ? error->message : "failed");
    return 1;
  }
  // Real iPods tend to have a smart playlist, which must survive every sync.
  Itdb_iTunesDB *db = itdb_parse(argv[1], &error);
  if (!db) return 1;
  Itdb_Playlist *smart = itdb_playlist_new("Smart Mix", TRUE);
  itdb_playlist_add(db, smart, -1);
  itdb_splr_add_new(smart, -1);
  if (!itdb_write(db, &error)) {
    printf("%s\n", error ? error->message : "failed");
    return 1;
  }
  itdb_free(db);
  return 0;
}
