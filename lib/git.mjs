import { exec } from './exec.mjs';
import { startSpan } from './tracing.mjs';

export function commitExists(repoDir, hash) {
  try {
    exec(`git -C "${repoDir}" cat-file -e ${hash}^{commit}`, { silent: true });
    return true;
  } catch {
    return false;
  }
}

export function cloneRepo(repoUrl, targetDir, { emitProgress, jsonProgress }) {
  const span = startSpan('analyzer.clone', {
    'git.repository.url': repoUrl,
    'git.clone.target_dir': targetDir
  });

  if (!jsonProgress) {
    console.log(`\n📦 Cloning repository: ${repoUrl}`);
  }
  emitProgress('cloning', 5, `Cloning repository: ${repoUrl}`);

  try {
    exec(`git clone "${repoUrl}" "${targetDir}"`, { silent: jsonProgress });

    if (!jsonProgress) {
      console.log('✓ Clone complete');
    }
    emitProgress('cloning', 10, 'Clone complete');
    span.setStatus('ok');
  } catch (err) {
    span.setStatus('error', err.message);
    span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

export function getCommitHistory(repoDir, branch = 'main', afterCommit = null, { emitProgress, jsonProgress }) {
  const span = startSpan('analyzer.get_commits', {
    'git.branch': branch,
    'git.after_commit': afterCommit || 'none'
  });

  const label = afterCommit ? 'new commits' : 'commit history';
  if (!jsonProgress) {
    console.log(`\n📜 Getting ${label} from branch: ${branch}`);
  }

  try {
    const branches = exec(`git -C "${repoDir}" branch -r`, { silent: true });
    const hasMain = branches.includes('origin/main');
    const hasMaster = branches.includes('origin/master');

    let actualBranch = branch;
    if (branch === 'main' && !hasMain) {
      if (hasMaster) {
        actualBranch = 'master';
        if (!jsonProgress) {
          console.log('  (using master branch instead)');
        }
      } else {
        const defaultBranchRef = exec(
          `git -C "${repoDir}" symbolic-ref refs/remotes/origin/HEAD`,
          { silent: true, ignoreError: true }
        );
        if (defaultBranchRef && defaultBranchRef.trim()) {
          const match = defaultBranchRef.trim().match(/refs\/remotes\/origin\/(.+)/);
          if (match) {
            actualBranch = match[1];
            if (!jsonProgress) {
              console.log(`  (using default branch '${actualBranch}' instead)`);
            }
          }
        }
      }
    }

    span.setAttributes({ 'git.actual_branch': actualBranch });

    let logCmd = `git -C "${repoDir}" log ${actualBranch} --reverse --pretty=format:"%H|%ad|%s" --date=short`;
    if (afterCommit) {
      logCmd = `git -C "${repoDir}" log ${afterCommit}..${actualBranch} --reverse --pretty=format:"%H|%ad|%s" --date=short`;
    }

    const commits = exec(logCmd, { silent: true })
      .split('\n')
      .filter(line => line.trim());

    if (!jsonProgress) {
      console.log(`✓ Found ${commits.length} commits`);
    }
    emitProgress('analyzing', 12, `Found ${commits.length} commits`, { total_commits: commits.length });

    span.setAttributes({ 'git.commits.count': commits.length });
    span.setStatus('ok');

    return commits.map(line => {
      const [hash, date, ...messageParts] = line.split('|');
      return {
        hash: hash.trim(),
        date: date.trim(),
        message: messageParts.join('|').trim()
      };
    });
  } catch (err) {
    span.setStatus('error', err.message);
    span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

export function addWorktree(baseRepoDir, worktreeDir) {
  exec(`git -C "${baseRepoDir}" worktree add --detach "${worktreeDir}"`, { silent: true });
}

export function removeWorktree(baseRepoDir, worktreeDir) {
  exec(`git -C "${baseRepoDir}" worktree remove --force "${worktreeDir}"`, { silent: true, ignoreError: true });
  exec(`git -C "${baseRepoDir}" worktree prune`, { silent: true, ignoreError: true });
}
