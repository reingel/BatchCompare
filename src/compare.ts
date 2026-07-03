import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type DiffStatus = 'same' | 'modified' | 'onlyLeft' | 'onlyRight';

export interface DiffNode {
  name: string;
  relPath: string;
  isDirectory: boolean;
  status: DiffStatus;
  children?: DiffNode[];
}

export async function compareFolders(
  leftRoot: string,
  rightRoot: string,
  exclude: string[]
): Promise<DiffNode[]> {
  const excludeSet = new Set(exclude);
  return compareDir(leftRoot, rightRoot, '', excludeSet);
}

async function compareDir(
  leftDir: string,
  rightDir: string,
  relPath: string,
  exclude: Set<string>
): Promise<DiffNode[]> {
  const [leftEntries, rightEntries] = await Promise.all([
    readEntries(leftDir),
    readEntries(rightDir),
  ]);

  const names = new Set([...leftEntries.keys(), ...rightEntries.keys()]);
  const nodes: DiffNode[] = [];

  for (const name of names) {
    if (exclude.has(name)) {
      continue;
    }
    const left = leftEntries.get(name);
    const right = rightEntries.get(name);
    const childRelPath = relPath ? `${relPath}/${name}` : name;

    if (left && right) {
      if (left.isDirectory() && right.isDirectory()) {
        const children = await compareDir(
          path.join(leftDir, name),
          path.join(rightDir, name),
          childRelPath,
          exclude
        );
        const allSame = children.every((c) => c.status === 'same');
        nodes.push({
          name,
          relPath: childRelPath,
          isDirectory: true,
          status: allSame ? 'same' : 'modified',
          children,
        });
      } else if (!left.isDirectory() && !right.isDirectory()) {
        const equal = await filesEqual(
          path.join(leftDir, name),
          path.join(rightDir, name)
        );
        nodes.push({
          name,
          relPath: childRelPath,
          isDirectory: false,
          status: equal ? 'same' : 'modified',
        });
      } else {
        // One side is a directory, the other a file — different kinds
        nodes.push({
          name,
          relPath: childRelPath,
          isDirectory: false,
          status: 'modified',
        });
      }
    } else {
      const entry = (left ?? right)!;
      const side: DiffStatus = left ? 'onlyLeft' : 'onlyRight';
      if (entry.isDirectory()) {
        const dir = path.join(left ? leftDir : rightDir, name);
        nodes.push({
          name,
          relPath: childRelPath,
          isDirectory: true,
          status: side,
          children: await scanOneSide(dir, childRelPath, side, exclude),
        });
      } else {
        nodes.push({
          name,
          relPath: childRelPath,
          isDirectory: false,
          status: side,
        });
      }
    }
  }

  return sortNodes(nodes);
}

async function scanOneSide(
  dir: string,
  relPath: string,
  status: DiffStatus,
  exclude: Set<string>
): Promise<DiffNode[]> {
  const entries = await readEntries(dir);
  const nodes: DiffNode[] = [];
  for (const [name, entry] of entries) {
    if (exclude.has(name)) {
      continue;
    }
    const childRelPath = `${relPath}/${name}`;
    if (entry.isDirectory()) {
      nodes.push({
        name,
        relPath: childRelPath,
        isDirectory: true,
        status,
        children: await scanOneSide(path.join(dir, name), childRelPath, status, exclude),
      });
    } else {
      nodes.push({ name, relPath: childRelPath, isDirectory: false, status });
    }
  }
  return sortNodes(nodes);
}

async function readEntries(dir: string): Promise<Map<string, fs.Dirent>> {
  const map = new Map<string, fs.Dirent>();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    map.set(entry.name, entry);
  }
  return map;
}

async function filesEqual(leftPath: string, rightPath: string): Promise<boolean> {
  let leftStat: fs.Stats;
  let rightStat: fs.Stats;
  try {
    [leftStat, rightStat] = await Promise.all([
      fs.promises.stat(leftPath),
      fs.promises.stat(rightPath),
    ]);
  } catch {
    return false;
  }
  if (leftStat.size !== rightStat.size) {
    return false;
  }
  const [leftHash, rightHash] = await Promise.all([
    hashFile(leftPath),
    hashFile(rightPath),
  ]);
  return leftHash === rightHash;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sortNodes(nodes: DiffNode[]): DiffNode[] {
  return nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}
