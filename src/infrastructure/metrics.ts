/** Metricas em memoria no formato texto do Prometheus. Por instancia; o coletor soma. NUNCA usado para idempotencia. */
export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, () => number | Promise<number>>();
  private hist = new Map<string, { sum: number; count: number; buckets: number[] }>();
  private static readonly BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  gauge(name: string, fn: () => number | Promise<number>): void {
    this.gauges.set(name, fn);
  }

  observe(name: string, seconds: number): void {
    const h = this.hist.get(name) ?? {
      sum: 0,
      count: 0,
      buckets: new Array(Metrics.BOUNDS.length).fill(0),
    };
    h.sum += seconds;
    h.count += 1;
    Metrics.BOUNDS.forEach((b, i) => {
      if (seconds <= b) h.buckets[i] = (h.buckets[i] ?? 0) + 1;
    });
    this.hist.set(name, h);
  }

  value(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(this.key(name, labels)) ?? 0;
  }

  async render(): Promise<string> {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [name, fn] of this.gauges) lines.push(`${name} ${await fn()}`);
    for (const [name, h] of this.hist) {
      Metrics.BOUNDS.forEach((b, i) => lines.push(`${name}_bucket{le="${b}"} ${h.buckets[i] ?? 0}`));
      lines.push(`${name}_bucket{le="+Inf"} ${h.count}`);
      lines.push(`${name}_sum ${h.sum}`);
      lines.push(`${name}_count ${h.count}`);
    }
    return lines.join('\n') + '\n';
  }

  private key(name: string, labels: Record<string, string>): string {
    const e = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return e.length ? `${name}{${e.map(([k, v]) => `${k}="${v}"`).join(',')}}` : name;
  }
}

export const metrics = new Metrics();
