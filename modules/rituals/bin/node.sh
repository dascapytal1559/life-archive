# Sourced by every bin/ wrapper after RITUAL_HOME (the code's folder) is set: chooses the Node.js binary and leaves it
# in RITUAL_NODE. Order: RITUAL_NODE in the environment (an explicit override, used as given), then the absolute path
# written to the ignored per-installation file config/node beside the code, then `node` on PATH only when it is version
# 24 or newer. Anything else prints the same JSON error shape as the commands themselves and exits 1, so a wrong Node
# never runs anything. A wrong version named by RITUAL_NODE or config/node is refused by src/cli.ts with the same shape.
# RITUAL_ROOT, where the store is, is the environment's to set and src/root.ts's to read: the wrappers leave it alone.
ritual_node_is_current() {
  ritual_node_version=$("$1" --version 2>/dev/null) || return 1
  case "$ritual_node_version" in v2[4-9].*|v[3-9][0-9].*|v[1-9][0-9][0-9]*.*) return 0 ;; *) return 1 ;; esac
}
ritual_node_fail() {
  printf '{"ok":false,"error":"%s"}\n' "$1"
  exit 1
}
if [ -n "${RITUAL_NODE:-}" ]; then
  :
elif [ -f "$RITUAL_HOME/config/node" ]; then
  read -r RITUAL_NODE < "$RITUAL_HOME/config/node" || RITUAL_NODE=
  case "$RITUAL_NODE" in
    /*) [ -x "$RITUAL_NODE" ] || ritual_node_fail "config/node names a Node.js binary that is missing or not executable: $RITUAL_NODE" ;;
    *) ritual_node_fail "config/node must hold the absolute path of a Node.js 24 binary on its first line" ;;
  esac
elif ritual_node_found=$(command -v node 2>/dev/null) && ritual_node_is_current "$ritual_node_found"; then
  RITUAL_NODE=$ritual_node_found
else
  ritual_node_fail "Rituals needs Node.js 24 or later: write its absolute path to config/node, set RITUAL_NODE, or put it first on PATH"
fi
