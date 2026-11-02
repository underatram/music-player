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
  return 0;
}
