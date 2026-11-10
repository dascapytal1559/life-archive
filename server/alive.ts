/** Whether the process `pid` is running (on this machine). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it is alive, but another user's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
