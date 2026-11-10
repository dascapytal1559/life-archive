// The program a launchd job of the archive's runs when it needs Full Disk Access: this Mac's calls and Messages
// (server/mac-imports.ts) and the journal module's voice journals (modules/journal/cli.ts, built through the SDK);
// docs/data.md's "This Mac's calls and Messages, every 15 minutes" and docs/features.md's "Voice journals, transcribed at 6 AM".
//
// Reading another app's data (the Messages app's and the call history's databases, Voice Memos' recordings) takes Full
// Disk Access. macOS gives it to the program launchd starts and to every process that program starts, so the captain
// grants it to one small program per job rather than to node, whose other launchd agents (the archive's server among
// them) would then have it too. It runs one command only, LA_NODE --no-warnings LA_REPO LA_SCRIPT run, in LA_REPO, all
// set when it is built (`buildLauncher` in server/jobs.ts); it passes launchd's SIGTERM on, and exits as that command
// does. It sets LA_ENV to its own path, so the command can name the program that needs the grant when it has none.
//
// macOS knows the program by the hash of its code signature: built again from changed source or paths, it is a new
// program, and its grant is given again.

#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

// Built before the launcher served more than one job, mac-imports' launcher named its script and variable itself:
// these defaults keep its bytes, and so its grant.
#ifndef LA_SCRIPT
#define LA_SCRIPT "/server/mac-imports.ts"
#endif
#ifndef LA_ENV
#define LA_ENV "LIFE_ARCHIVE_MAC_IMPORTS_LAUNCHER"
#endif

extern char **environ;
static pid_t child = 0;

static void pass_on(int sig) {
  if (child > 0) kill(child, sig);
}

int main(int argc, char **argv) {
  (void)argc;
  if (chdir(LA_REPO) != 0) {
    fprintf(stderr, "cannot go into %s: %s\n", LA_REPO, strerror(errno));
    return 1;
  }
  // So the command can name the program that needs Full Disk Access when it has not been given it.
  setenv(LA_ENV, argv[0], 1);
  char *const args[] = {LA_NODE, "--no-warnings", LA_REPO LA_SCRIPT, "run", NULL};
  signal(SIGTERM, pass_on);
  signal(SIGINT, pass_on);
  int failed = posix_spawn(&child, LA_NODE, NULL, NULL, args, environ);
  if (failed != 0) {
    fprintf(stderr, "cannot start %s: %s\n", LA_NODE, strerror(failed));
    return 1;
  }
  int status;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) {
      perror("waitpid");
      return 1;
    }
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 128 + WTERMSIG(status);
}
