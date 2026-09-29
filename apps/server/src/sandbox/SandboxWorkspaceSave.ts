// Shell scripts that save a sandbox's workspace and put it back. A save holds only what
// can't be recreated: the seed commit comes back from the host's repo, and what the
// project's setup script made comes back by running it again. Everything else is kept,
// ignored files included. `setupMade` lists, as \`git ls-files --others --ignored
// --directory -z\` does, the ignored paths present right after setup; without it every
// ignored file is kept. Paths are quoted by the caller's `quote`.

// Anchored patterns for the paths setup made; an empty list skips nothing.
const setupMadePatterns = (setupMade: string, out: string) =>
  `if [ -f ${setupMade} ]; then
  tr '\\0' '\\n' < ${setupMade} | sed -e 's/[][\\.*^$+?(){}|]/\\\\&/g' -e 's/^/^/' > ${out}/setup-made
else
  : > ${out}/setup-made
fi`;

/** Writes `out` with the commits, refs and uncommitted work made on top of `seed`. */
export const saveWorkspaceScript = (input: {
  readonly workspace: string;
  readonly out: string;
  readonly seed: string;
  readonly setupMade: string;
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
# The seed's tree is excluded too: T3's checkpoints are commits without parents.
git rev-list --objects --all --reflog --indexed-objects HEAD $index_tree \\
  --not ${input.seed} ${input.seed}^{tree} |
  git pack-objects -q ${input.out}/work >/dev/null
# Refs and config; objects come from the seed and the pack above.
tar -czf ${input.out}/git.tar.gz -C .git --exclude=./objects $skip_index .
# Uncommitted work: changed, untracked and ignored files, except what setup made.
${setupMadePatterns(input.setupMade, input.out)}
git ls-files -z --deleted > ${input.out}/deleted
{
  git ls-files -z --modified --others --exclude-standard
  git ls-files -z --others --ignored --exclude-standard |
    { grep -zvE -f ${input.out}/setup-made || true; }
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
  readonly setupMade: string;
}) => `set -eu
rm -rf ${input.out}
mkdir -p ${input.out}
cd ${input.workspace}
if [ -f ${input.setupMade} ]; then
  tr '\\0' '\\n' < ${input.setupMade} | sed -e 's#/$##' -e 's#^#./#' > ${input.out}/skipped
else
  : > ${input.out}/skipped
fi
tar -czf ${input.out}/workspace.tar.gz --anchored --exclude-from=${input.out}/skipped .
`;

export const restoreWholeWorkspaceScript = (input: {
  readonly workspace: string;
  readonly from: string;
}) => `set -eu
tar -xzf ${input.from}/workspace.tar.gz -C ${input.workspace}
`;
