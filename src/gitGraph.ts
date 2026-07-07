// git log의 커밋들을 순서대로 입력받아 그래프 레인 레이아웃을 계산한다.
// y좌표는 행 높이를 0(위)~1(아래)로 정규화한 값이며, 0.5는 커밋 노드(점) 위치를 뜻한다.
export interface GraphTrack {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: number;
}

export interface GraphRow {
  column: number;
  color: number;
  tracks: GraphTrack[];
}

export class GitGraphBuilder {
  private lanes: (string | null)[] = [];
  private colors: number[] = [];
  private nextColor = 0;

  // hash: 이 커밋의 해시. parents: 부모 커밋 해시 목록(1개 초과면 병합 커밋).
  processCommit(hash: string, parents: string[]): GraphRow {
    // 서로 다른 레인이 같은 조상 커밋(예: 병합 베이스)을 기다리고 있을 수 있으므로
    // 일치하는 레인을 모두 찾는다. 가장 왼쪽 레인이 이어지고 나머지는 이 노드로 합류한다.
    const matches: number[] = [];
    for (let c = 0; c < this.lanes.length; c++) {
      if (this.lanes[c] === hash) {
        matches.push(c);
      }
    }
    const existed = matches.length > 0;
    let col: number;
    let color: number;
    if (existed) {
      col = matches[0];
      color = this.colors[col];
    } else {
      col = this.lanes.indexOf(null);
      if (col === -1) {
        col = this.lanes.length;
      }
      color = this.nextColor++;
    }
    const convergent = matches.slice(1);
    const skip = new Set(convergent);
    skip.add(col);

    const tracks: GraphTrack[] = [];

    // 이 커밋과 무관하게 지나가는 다른 레인들은 위-아래로 곧게 통과시킨다.
    for (let c = 0; c < this.lanes.length; c++) {
      if (!skip.has(c) && this.lanes[c] != null) {
        tracks.push({ x0: c, y0: 0, x1: c, y1: 1, color: this.colors[c] });
      }
    }

    if (existed) {
      tracks.push({ x0: col, y0: 0, x1: col, y1: 0.5, color });
    }
    for (const c of convergent) {
      tracks.push({ x0: c, y0: 0, x1: col, y1: 0.5, color: this.colors[c] });
      this.lanes[c] = null;
    }

    const [firstParent, ...mergeParents] = parents;
    if (firstParent) {
      this.lanes[col] = firstParent;
      this.colors[col] = color;
      tracks.push({ x0: col, y0: 0.5, x1: col, y1: 1, color });
    } else {
      this.lanes[col] = null;
    }

    for (const parent of mergeParents) {
      const existingLane = this.lanes.indexOf(parent);
      if (existingLane !== -1) {
        tracks.push({ x0: col, y0: 0.5, x1: existingLane, y1: 1, color: this.colors[existingLane] });
        continue;
      }
      let lane = this.lanes.indexOf(null);
      if (lane === -1) {
        lane = this.lanes.length;
      }
      const mergeColor = this.nextColor++;
      this.lanes[lane] = parent;
      this.colors[lane] = mergeColor;
      tracks.push({ x0: col, y0: 0.5, x1: lane, y1: 1, color: mergeColor });
    }

    // 꼬리 쪽의 빈 레인은 잘라내어 그래프 폭이 계속 늘어나지 않게 한다.
    while (this.lanes.length > 0 && this.lanes[this.lanes.length - 1] == null) {
      this.lanes.pop();
      this.colors.pop();
    }

    return { column: col, color, tracks };
  }

  get width(): number {
    return Math.max(this.lanes.length, 1);
  }
}
