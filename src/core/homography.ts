import type { Vec } from '../types/document';

/** 3×3 单应矩阵，行优先 9 个数（h33 固定为 1）。 */
export type Homography = number[];

function solveLinear(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-10) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const divisor = a[column][column];
    for (let k = column; k <= size; k += 1) a[column][k] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = a[row][column];
      for (let k = column; k <= size; k += 1) a[row][k] -= factor * a[column][k];
    }
  }
  return a.map((row) => row[size]);
}

/** 由 4 组对应点求单应变换（src → dst）；退化四边形返回 null。 */
export function solveHomography(src: Vec[], dst: Vec[]): Homography | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const matrix: number[][] = [];
  const vector: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = src[index];
    const { x: u, y: v } = dst[index];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }
  const solution = solveLinear(matrix, vector);
  return solution ? [...solution, 1] : null;
}

export function applyHomography(h: Homography, point: Vec): Vec {
  const denominator = h[6] * point.x + h[7] * point.y + 1;
  if (Math.abs(denominator) < 1e-9) return { x: point.x, y: point.y };
  return {
    x: (h[0] * point.x + h[1] * point.y + h[2]) / denominator,
    y: (h[3] * point.x + h[4] * point.y + h[5]) / denominator
  };
}
