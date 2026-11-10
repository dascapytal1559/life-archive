# Puts the pinned Node (.node-version) first on the PATH of the shell that sources this, when the PATH's own node is
# another version: a pipeline or a daemon whose PATH was not set up for this project. It looks where the usual version
# managers install a version (nvm, fnm, mise, Volta) and at the Vite+ shims, which run the pinned version themselves.
# When none has it, it changes nothing, and npm test then says which version it needs (server/nodeVersion.ts).
#   . tools/pinned-node.sh        (from the repository's root)

pinned_node=$(cat .node-version)
if [ "$(node --version 2>/dev/null)" != "v$pinned_node" ]; then
  for pinned_dir in \
    "${NVM_DIR:-$HOME/.nvm}/versions/node/v$pinned_node/bin" \
    "${FNM_DIR:-$HOME/.local/share/fnm}/node-versions/v$pinned_node/installation/bin" \
    "$HOME/Library/Application Support/fnm/node-versions/v$pinned_node/installation/bin" \
    "${MISE_DATA_DIR:-$HOME/.local/share/mise}/installs/node/$pinned_node/bin" \
    "${VOLTA_HOME:-$HOME/.volta}/tools/image/node/$pinned_node/bin" \
    "$HOME/.vite-plus/bin"; do
    if [ -x "$pinned_dir/node" ] && [ "$("$pinned_dir/node" --version 2>/dev/null)" = "v$pinned_node" ]; then
      PATH="$pinned_dir:$PATH"
      export PATH
      break
    fi
  done
fi
unset pinned_node pinned_dir
