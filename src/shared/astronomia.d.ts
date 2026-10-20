// astronomia には型定義がないので、使うものだけを宣言する。
// このファイルは import / export を持たない（持つと、モジュールの宣言ではなく拡張になってしまう）。

declare module 'astronomia/planetposition' {
  export type Vsop87Series = Record<string, readonly (readonly number[])[]>;

  export interface Vsop87Data {
    L: Vsop87Series;
    B: Vsop87Series;
    R: Vsop87Series;
    name: string;
    type: string;
  }

  export interface Coord {
    /** 黄経（ラジアン） */
    lon: number;
    /** 黄緯（ラジアン） */
    lat: number;
    /** 距離（天文単位） */
    range: number;
  }

  export class Planet {
    constructor(data: Vsop87Data);
    position2000(jde: number): Coord;
    position(jde: number): Coord;
  }

  const planetposition: { Planet: typeof Planet };
  export default planetposition;
}

declare module 'astronomia/solar' {
  import type { Coord, Planet } from 'astronomia/planetposition';

  /** 太陽の視位置（章動と光行差を含む）。jde は ユリウス日（力学時）。 */
  export function apparentVSOP87(planet: Planet, jde: number): Coord;
}

declare module 'astronomia/deltat' {
  /** ΔT（力学時 − 世界時）を秒で返す。dyear は小数の年。 */
  export function deltaT(dyear: number): number;
}

declare module 'astronomia/data/vsop87Bearth' {
  import type { Vsop87Data } from 'astronomia/planetposition';

  // 間引く前の元データ。画面・Worker のコードからは import しない（約 127KB あるため）。
  const earth: Vsop87Data;
  export default earth;
}
