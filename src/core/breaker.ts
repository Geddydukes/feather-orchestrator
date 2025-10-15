
export class Breaker {
  private state: "closed" | "open" | "half" = "closed";
  private nextTry = 0;
  private events: number[] = []; // timestamps
  public onStateChange?: (state: "closed" | "open" | "half") => void;
  
  constructor(
    private threshold = 5,
    private coolMs = 5000,
    private windowMs = 10000,
    private classify: (e: unknown) => "soft" | "hard" = () => "soft"
  ) {}

  canPass(): boolean {
    if (this.state === "open" && Date.now() < this.nextTry) return false;
    if (this.state === "open") {
      this.state = "half";
      this.onStateChange?.("half");
    }
    return true;
  }

  success(): void {
    this.sweep();
    if (this.state === "half") {
      this.state = "closed";
      this.onStateChange?.("closed");
    }
  }

  fail(e?: unknown): void {
    const severity = this.classify(e);
    // Avoid opening on "hard" client errors (e.g., 400/401/403/404)
    if (severity === "hard") return;
    
    this.events.push(Date.now());
    this.sweep();
    
    if (this.failCount() >= this.threshold) {
      this.state = "open";
      this.nextTry = Date.now() + this.coolMs;
      this.onStateChange?.("open");
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.events.length && this.events[0] < cutoff) {
      this.events.shift();
    }
  }

  private failCount(): number {
    this.sweep(); // Always sweep before counting
    return this.events.length;
  }

  getState(): "closed" | "open" | "half" {
    return this.state;
  }

  getFailureCount(): number {
    return this.failCount();
  }
}
