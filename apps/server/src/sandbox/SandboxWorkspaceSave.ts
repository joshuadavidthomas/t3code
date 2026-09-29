// Shell scripts that save a sandbox's workspace and put it back. A save holds only what
// the host can't recreate: the seed commit comes from the host's repo on restore, so the
// save is the work since then. Paths are quoted by the caller's `quote`.

/** Writes `out` with the commits, refs and uncommitted work made on top of `seed`. */
export const saveWorkspaceScript = (input: {
  readonly workspace: string;
  readonly out: string;
  readonly seed: string;
}) => `set -eu
rm -rf ${input.out}
mkdir -p ${input.out}
cd ${input.workspace}
# The index is saved as the tree it describes, a few objects instead of a large file;
# an index with conflicts can't be one, so it is kept as it is.
skip_index=
if index_tree=$(git write-tree 2>/dev/null); then
  echo "$index_tree" > ${input.out}/index-tree
  skip_index=--exclude=./index
fi
# Commits, stashes and staged files made here, minus everything the seed already has.
git rev-list --objects --all --reflog --indexed-objects HEAD $index_tree --not ${input.seed} |
  git pack-objects -q ${input.out}/work >/dev/null
# Refs and config; objects come from the seed and the pack above.
tar -czf ${input.out}/git.tar.gz -C .git --exclude=./objects $skip_index .
# Uncommitted work: changed and untracked files, and ignored files outside node_modules,
# which worktree cleanup treats as precious too.
git ls-files -z --deleted > ${input.out}/deleted
{
  git ls-files -z --modified --others --exclude-standard
  git ls-files -z --others --ignored --exclude-standard | { grep -zvE '(^|/)node_modules/' || true; }
} > ${input.out}/changed
tar -czf ${input.out}/changes.tar.gz --null --ignore-failed-read -T ${input.out}/changed 2>/dev/null
`;

/** Puts a save back into a workspace that already holds the seed's objects. */
export const restoreWorkspaceScript = (input: {
  readonly workspace: string;
  readonly from: string;
}) => `set -eu
cd ${input.workspace}
tar -xzf ${input.from}/git.tar.gz -C .git
for pack in ${input.from}/work-*.pack; do git index-pack --stdin < "$pack" >/dev/null; done
if [ -f ${input.from}/index-tree ]; then git read-tree "$(cat ${input.from}/index-tree)"; fi
git checkout-index --all --force
xargs -0 -r rm -f -- < ${input.from}/deleted
tar -xzf ${input.from}/changes.tar.gz
`;

/** When the host no longer has the seed, the workspace is saved whole instead. */
export const saveWholeWorkspaceScript = (input: {
  readonly workspace: string;
  readonly out: string;
}) => `set -eu
rm -rf ${input.out}
mkdir -p ${input.out}
cd ${input.workspace}
git ls-files -z --others --ignored --exclude-standard --directory |
  tr '\\0' '\\n' | { grep -E '(^|/)node_modules/$' || true; } | sed -e 's#/$##' -e 's#^#./#' > ${input.out}/skipped
# Anchored, so a tracked folder that happens to be named node_modules is kept.
tar -czf ${input.out}/workspace.tar.gz --anchored --exclude-from=${input.out}/skipped .
`;

export const restoreWholeWorkspaceScript = (input: {
  readonly workspace: string;
  readonly from: string;
}) => `set -eu
tar -xzf ${input.from}/workspace.tar.gz -C ${input.workspace}
`;
