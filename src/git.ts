import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';

export interface GitCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  date: string;
  refs: string;
  subject: string;
}

// vsix 배포 후에도 정리할 수 있도록, 이 세션에서 추출한 임시 폴더를 기록해 둔다.
const extractedDirs = new Set<string>();

function runGit(repoPath: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repoPath, ...args],
      { maxBuffer: 64 * 1024 * 1024, env },
      (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

export async function getRepoRoot(dir: string): Promise<string | undefined> {
  try {
    const out = await runGit(dir, ['rev-parse', '--show-toplevel']);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function getCommits(repoPath: string): Promise<GitCommit[]> {
  // \x1f(unit sep)로 필드를, \x1e(record sep)로 커밋을 구분하여
  // subject에 쉼표/개행이 있어도 안전하게 파싱한다.
  let out: string;
  try {
    out = await runGit(repoPath, [
      'log',
      '--all',
      'HEAD',
      '--topo-order',
      '--date=format:%Y-%m-%d %H:%M',
      '--pretty=format:%H\x1f%h\x1f%P\x1f%an\x1f%ad\x1f%D\x1f%s\x1e',
    ]);
  } catch {
    // 커밋이 하나도 없는 저장소에서는 git log가 실패한다.
    return [];
  }

  const commits: GitCommit[] = [];
  for (const record of out.split('\x1e')) {
    const trimmed = record.replace(/^\n/, '');
    if (!trimmed) {
      continue;
    }
    const [hash, shortHash, parents, author, date, refs, subject] = trimmed.split('\x1f');
    if (!hash) {
      continue;
    }
    commits.push({
      hash,
      shortHash,
      parents: parents ? parents.split(' ') : [],
      author,
      date,
      refs,
      subject: subject ?? '',
    });
  }
  return commits;
}

// 작업 트리에 커밋되지 않은 변경사항이 있는지, 있다면 몇 개 파일이 변경되었는지 반환한다.
export async function getUncommittedCount(repoPath: string): Promise<number> {
  try {
    const out = await runGit(repoPath, ['status', '--porcelain']);
    const lines = out.split('\n').filter((l) => l.trim().length > 0);
    return lines.length;
  } catch {
    return 0;
  }
}

export async function getHeadHash(repoPath: string): Promise<string | undefined> {
  try {
    const out = await runGit(repoPath, ['rev-parse', 'HEAD']);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

// 커밋의 파일 트리를 임시 폴더로 추출하고 그 경로를 반환한다.
// 각 추출마다 별도 디렉터리를 사용해 기존 비교와 동시 비교를 보존한다.
export async function extractCommit(
  repoPath: string,
  hash: string,
  shortHash: string
): Promise<string> {
  const repoName = path.basename(repoPath).replace(/[^\w.-]/g, '_');
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'batch-compare-git-'));
  extractedDirs.add(tempRoot);
  const dir = path.join(tempRoot, repoName, shortHash.replace(/[^\w.-]/g, '_'));
  await fs.promises.mkdir(dir, { recursive: true });

  // 외부 tar는 OS마다 동작이 달라(Windows bsdtar/GNU tar) 쓰지 않는다.
  // 임시 index에 커밋 트리를 읽어 checkout-index로 꺼내므로 저장소의 index와 작업 트리는 그대로다.
  const env = { ...process.env, GIT_INDEX_FILE: path.join(tempRoot, 'index') };
  // --prefix는 문자열을 그대로 앞에 붙이므로 끝에 '/'가 있어야 하고, Windows 구분자도 '/'로 통일한다.
  const prefix = dir.split(path.sep).join('/') + '/';
  try {
    await runGit(repoPath, ['read-tree', hash], env);
    await runGit(repoPath, ['checkout-index', '-a', '-f', `--prefix=${prefix}`], env);
  } catch (err) {
    throw new Error(`git extract failed: ${(err as Error).message}`);
  } finally {
    await fs.promises.rm(env.GIT_INDEX_FILE, { force: true });
  }

  return dir;
}

export function cleanupExtractedDirs(): void {
  for (const dir of extractedDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 임시 폴더 정리는 실패해도 무방하다.
    }
  }
  extractedDirs.clear();
}
