
export class Breaker {
  private failures = 0;
  private state: "closed" | "open" | "half" = "closed";
  private nextTry = 0;
  constructor(private threshold = 5, private coolMs = 5000) {}
  canPass() {
    if (this.state === "open" && Date.now() < this.nextTry) return false;
    if (this.state === "open") this.state = "half";
    return true;
  }
  success() { this.failures = 0; this.state = "closed"; }
  fail() {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = "open";
      this.nextTry = Date.now() + this.coolMs;
    }
  }
}
