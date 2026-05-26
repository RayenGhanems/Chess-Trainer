const ENGINE_CANDIDATES = [
  {
    label: "Local Stockfish 18 lite",
    scriptUrl: new URL("../../../vendor/stockfish/stockfish-18-lite-single.js", import.meta.url).href,
  },
  {
    label: "Local Stockfish 18 asm fallback",
    scriptUrl: new URL("../../../vendor/stockfish/stockfish-18-asm.js", import.meta.url).href,
  },
];

export class StockfishBridge {
  constructor(onStatus, options = {}) {
    this.onStatus = onStatus;
    this.createWorker = options.createWorker ?? ((scriptUrl) => new Worker(scriptUrl));
    this.timers = options.timers ?? globalThis;
    this.worker = null;
    this.ready = false;
    this.activeJob = null;
    this.jobQueue = [];
    this.processing = false;
    this.engineUrl = null;
  }

  async init() {
    let lastError = null;
    for (const candidate of ENGINE_CANDIDATES) {
      try {
        this.onStatus(`Loading ${candidate.label}...`);
        await this.connect(candidate);
        this.engineUrl = candidate.scriptUrl;
        this.onStatus(`${candidate.label} ready`);
        return;
      } catch (error) {
        lastError = error;
        this.disposeWorker();
      }
    }

    throw lastError ?? new Error("Failed to initialize Stockfish.");
  }

  async analyze(fen, depth) {
    if (!this.ready || !this.worker) {
      throw new Error("Stockfish is not ready.");
    }

    return new Promise((resolve, reject) => {
      this.jobQueue.push({ fen, depth, resolve, reject });
      this.pump();
    });
  }

  newGame() {
    if (!this.ready || !this.worker) {
      return;
    }
    this.worker.postMessage("ucinewgame");
    this.worker.postMessage("isready");
  }

  cancelPendingJobs(reason = "superseded") {
    if (!this.jobQueue.length) {
      return;
    }
    const error = new Error(reason);
    while (this.jobQueue.length) {
      const job = this.jobQueue.shift();
      job?.reject(error);
    }
  }

  connect(candidate) {
    return new Promise((resolve, reject) => {
      try {
        const worker = this.createWorker(candidate.scriptUrl);
        let settled = false;
        const timeoutId = this.timers.setTimeout(() => {
          fail(new Error("Timed out while loading the Stockfish worker."));
        }, 15000);

        const cleanup = () => {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          this.timers.clearTimeout(timeoutId);
        };

        const fail = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          try {
            worker.terminate();
          } catch {
            // Nothing actionable remains after a failed worker boot.
          }
          reject(error);
        };

        const succeed = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          this.worker = worker;
          this.ready = true;
          this.worker.addEventListener("message", (event) => this.handleMessage(String(event.data ?? "")));
          this.worker.postMessage("setoption name UCI_AnalyseMode value true");
          this.worker.postMessage("setoption name Skill Level value 20");
          this.worker.postMessage("ucinewgame");
          resolve();
        };

        const onMessage = (event) => {
          const line = String(event.data ?? "").trim();
          if (!line) {
            return;
          }
          if (line === "uciok") {
            worker.postMessage("isready");
            return;
          }
          if (line === "readyok") {
            succeed();
          }
        };

        const onError = (event) => {
          const detail = event?.message ? `: ${event.message}` : "";
          fail(new Error(`Failed to load worker from ${candidate.scriptUrl}${detail}`));
        };

        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.postMessage("uci");
      } catch (error) {
        reject(new Error(`Could not create a worker for ${candidate.label}: ${error.message}`));
      }
    });
  }

  async pump() {
    if (this.processing) {
      return;
    }

    this.processing = true;
    while (this.jobQueue.length) {
      const job = this.jobQueue.shift();
      try {
        const result = await this.executeJob(job.fen, job.depth);
        job.resolve(result);
      } catch (error) {
        job.reject(error);
      }
    }
    this.processing = false;
  }

  executeJob(fen, depth) {
    return new Promise((resolve, reject) => {
      const timeoutId = this.timers.setTimeout(() => {
        if (!this.activeJob) {
          return;
        }
        this.activeJob = null;
        try {
          this.worker?.postMessage("stop");
        } catch {
          // Timing out is already terminal for this job.
        }
        reject(new Error("Stockfish analysis timed out."));
      }, 20000);

      this.activeJob = {
        resolve,
        reject,
        timeoutId,
        depth,
        score: null,
        pv: [],
      };

      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go depth ${depth}`);
    });
  }

  handleMessage(line) {
    if (!this.activeJob) {
      return;
    }

    if (line.startsWith("info ")) {
      const parsed = parseEngineInfo(line);
      if (parsed.score) {
        this.activeJob.score = parsed.score;
      }
      if (parsed.pv.length) {
        this.activeJob.pv = parsed.pv;
      }
      return;
    }

    if (line.startsWith("bestmove")) {
      const parts = line.split(/\s+/);
      const bestmove = parts[1] ?? "(none)";
      const job = this.activeJob;
      this.activeJob = null;
      this.timers.clearTimeout(job.timeoutId);
      job.resolve({
        bestmove,
        score: job.score,
        pv: job.pv,
        depth: job.depth,
      });
    }
  }

  cancelActiveJob(reason = "disposed") {
    if (!this.activeJob) {
      return;
    }
    const job = this.activeJob;
    this.activeJob = null;
    this.timers.clearTimeout(job.timeoutId);
    job.reject(new Error(reason));
  }

  disposeWorker() {
    this.ready = false;
    this.cancelActiveJob("disposed");
    this.cancelPendingJobs("disposed");
    this.processing = false;
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Termination errors are not actionable here.
      }
    }
    this.worker = null;
  }
}

function parseEngineInfo(line) {
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  const pvMatch = line.match(/\bpv (.+)$/);
  const pv = pvMatch ? pvMatch[1].trim().split(/\s+/).filter(Boolean) : [];

  if (mateMatch) {
    return {
      score: { kind: "mate", value: Number(mateMatch[1]) },
      pv,
    };
  }

  if (cpMatch) {
    return {
      score: { kind: "cp", value: Number(cpMatch[1]) },
      pv,
    };
  }

  return { score: null, pv };
}
