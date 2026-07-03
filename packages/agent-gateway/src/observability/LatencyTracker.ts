export class LatencyTracker {
  private readonly startTime = performance.now();
  private firstTokenTime?: number;

  markFirstToken(): void {
    if (this.firstTokenTime === undefined) this.firstTokenTime = performance.now();
  }

  firstTokenLatencyMs(): number | undefined {
    return this.firstTokenTime === undefined ? undefined : Math.round(this.firstTokenTime - this.startTime);
  }

  totalLatencyMs(): number {
    return Math.round(performance.now() - this.startTime);
  }
}
