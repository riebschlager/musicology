export interface PlotOptions {
  readonly ariaDescription: string;
  readonly ariaLabel: string;
  readonly color: {
    readonly domain: readonly string[];
    readonly legend: boolean;
    readonly range: readonly string[];
  };
  readonly height: number;
  readonly marginBottom: number;
  readonly marks: readonly unknown[];
  readonly style: {
    readonly background: string;
    readonly color: string;
    readonly fontFamily: string;
    readonly fontSize: string;
  };
  readonly width: number;
  readonly x: {
    readonly label: string;
    readonly tickRotate: number;
    readonly ticks: number;
  };
  readonly y: {
    readonly grid: boolean;
    readonly label: string;
    readonly nice: boolean;
  };
}

export interface MarkOptions<T> {
  readonly fill: keyof T & string;
  readonly tip: boolean;
  readonly title?: ((row: T) => string) | string;
  readonly x: keyof T & string;
  readonly y: keyof T & string;
}

export function barY<T>(data: Iterable<T>, options: MarkOptions<T>): unknown;
export function plot(options: PlotOptions): HTMLElement | SVGSVGElement;
export function ruleY(data: Iterable<number>): unknown;
