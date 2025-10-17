# Feather Orchestrator

[![npm version](https://badge.fury.io/js/feather-orchestrator.svg)](https://badge.fury.io/js/feather-orchestrator)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

A **tiny, fast, dependency-light** LLM orchestrator that provides a unified API for multiple providers with enterprise-grade features: fallback chains, rate limiting, circuit breakers, retries, streaming, middleware, and cost tracking.

## ✨ Features

- 🎯 **Provider-Agnostic**: Works with any LLM provider (OpenAI, Anthropic, Google, Cohere, etc.)
- 🔄 **Fallback & Race**: Automatic failover and parallel execution
- 🚦 **Rate Limiting**: Token bucket algorithm with burst capacity
- 🔁 **Retry Logic**: Exponential backoff with jitter
- ⚡ **Circuit Breaker**: Prevents cascade failures
- 🌊 **Streaming**: Real-time responses with SSE
- 🔧 **Middleware**: Logging, monitoring, PII redaction
- 💰 **Cost Tracking**: Per-call and aggregate spending
- 📦 **Zero Dependencies**: Uses native Node.js `fetch`
- 🎨 **TypeScript**: Full type safety

## 🚀 Quick Start

### Installation

```bash
npm install feather-orchestrator
# or
pnpm add feather-orchestrator
# or
yarn add feather-orchestrator
```

> **Requires Node.js >= 18** (uses global `fetch`)

### Basic Usage

```typescript
import { Feather, openai, anthropic } from "feather-orchestrator";

// Initialize with multiple providers
const feather = new Feather({
  providers: {
    openai: openai({ apiKey: process.env.OPENAI_API_KEY! }),
    anthropic: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  },
  limits: {
    "openai:gpt-4": { rps: 5, burst: 10 },
    "anthropic:claude-3-5-haiku": { rps: 3, burst: 5 }
  }
});

// Simple chat
const response = await feather.chat({
  provider: "openai",
  model: "gpt-4",
  messages: [
    { role: "user", content: "Explain quantum computing in simple terms." }
  ]
});

console.log(response.content);
console.log(`Cost: $${response.costUSD}`);
```

## 📖 Complete API Reference

### Agent framework

The production-ready agent loop, memory backends, caching helpers, and guardrails now live alongside the core orchestrator. Start with the [Quick Start](docs/quick-start.md) guide and explore focused topics:

- [Memory backends & context building](docs/memory.md)
- [Prompt & tool caching](docs/prompt-caching.md)
- [Policies, guardrails & quotas](docs/policies-quotas.md)
- [Observability](docs/observability.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Subsystem overview](docs/overview.md)

Examples in `examples/` and utilities in `scripts/` demonstrate full runs, caching, observability dashboards, and NDJSON trace replay.

### Core Classes

#### `Feather`

The main orchestrator class that manages providers, rate limiting, retries, and middleware.

```typescript
interface FeatherOpts {
  providers?: Record<string, ChatProvider>;
  registry?: ProviderRegistry;
  limits?: Record<string, { rps: number; burst?: number }>;
  retry?: CallOpts["retry"];
  timeoutMs?: number;
  middleware?: Middleware[];
}
```

#### `ChatProvider`

Interface that any LLM provider must implement:

```typescript
interface ChatProvider {
  id: string;
  chat(req: ChatRequest, opts?: CallOpts): Promise<ChatResponse>;
  stream?(req: ChatRequest, opts?: CallOpts): AsyncIterable<ChatDelta>;
  estimate?(req: ChatRequest): TokenEstimate;
  price?: PriceTable;
}
```

### Methods

#### `feather.chat(options)`

Send a chat request to a specific provider.

```typescript
const response = await feather.chat({
  provider: "openai",        // Provider key
  model: "gpt-4",           // Model name
  messages: [               // Chat messages
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" }
  ],
  temperature: 0.7,         // Optional: 0-2
  maxTokens: 1000,          // Optional: max response tokens
  topP: 0.9                // Optional: 0-1
});
```

**Response:**
```typescript
interface ChatResponse {
  content: string;          // Generated text
  raw?: any;               // Raw provider response
  tokens?: {               // Token usage
    input?: number;
    output?: number;
  };
  costUSD?: number;        // Calculated cost
}
```

#### `feather.fallback(providers).chat(options)`

Try providers in sequence until one succeeds.

```typescript
const fallbackChain = feather.fallback([
  { provider: "openai", model: "gpt-4" },
  { provider: "anthropic", model: "claude-3-5-haiku" },
  { provider: "openai", model: "gpt-3.5-turbo" }
]);

const response = await fallbackChain.chat({
  messages: [{ role: "user", content: "Hello!" }]
});
// Will try gpt-4 first, then claude-3-5-haiku, then gpt-3.5-turbo
```

#### `feather.race(providers).chat(options)`

Try all providers simultaneously, return the first successful response.

```typescript
const raceChain = feather.race([
  { provider: "openai", model: "gpt-4" },
  { provider: "anthropic", model: "claude-3-5-haiku" }
]);

const response = await raceChain.chat({
  messages: [{ role: "user", content: "Hello!" }]
});
// Returns whichever responds first
```

#### `feather.stream.chat(options)`

Stream responses in real-time.

```typescript
for await (const delta of feather.stream.chat({
  provider: "openai",
  model: "gpt-4",
  messages: [{ role: "user", content: "Write a story." }],
  timeoutMs: 30000  // Optional: 30 second timeout
})) {
  process.stdout.write(delta.content || "");
}
```

#### `feather.map(items, fn, options)`

Process multiple items with controlled concurrency.

```typescript
const prompts = ["Explain AI", "What is React?", "How does HTTP work?"];

const results = await feather.map(
  prompts,
  async (prompt) => {
    const response = await feather.chat({
      provider: "openai",
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }]
    });
    return { prompt, response: response.content };
  },
  { concurrency: 2 }  // Process 2 at a time
);
```

## 🎯 Advanced Usage

### Provider-Agnostic Configuration

Define providers and model aliases in `feather.config.json`:

```json
{
  "policy": "cheapest",
  "providers": {
    "openai": {
      "apiKeyEnv": "OPENAI_API_KEY",
      "models": [
        {
          "name": "gpt-4",
          "aliases": ["smart", "expensive"],
          "inputPer1K": 0.03,
          "outputPer1K": 0.06
        },
        {
          "name": "gpt-3.5-turbo",
          "aliases": ["fast", "cheap"],
          "inputPer1K": 0.001,
          "outputPer1K": 0.002
        }
      ]
    },
    "anthropic": {
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "models": [
        {
          "name": "claude-3-5-haiku",
          "aliases": ["fast", "balanced"],
          "inputPer1K": 0.008,
          "outputPer1K": 0.024
        }
      ]
    }
  }
}
```

Use semantic model names:

```typescript
import { Feather, buildRegistry } from "feather-orchestrator";
import config from "./feather.config.json" assert { type: "json" };

const registry = buildRegistry(config);
const feather = new Feather({ registry });

// Use semantic aliases - orchestrator picks best option
const response = await feather.chat({
  model: "fast",  // Will pick cheapest "fast" model
  messages: [{ role: "user", content: "Hello!" }]
});
```

### Middleware System

Add logging, monitoring, and data transformation:

```typescript
const feather = new Feather({
  providers: { /* ... */ },
  middleware: [
    // Logging middleware
    async (ctx, next) => {
      console.log(`Request to ${ctx.provider}:${ctx.model}`);
      const start = Date.now();
      await next();
      console.log(`Response in ${Date.now() - start}ms`);
    },
    
    // Cost tracking middleware
    async (ctx, next) => {
      await next();
      if (ctx.response?.costUSD) {
        console.log(`Cost: $${ctx.response.costUSD.toFixed(6)}`);
        // Send to your metrics system
        metrics.recordCost(ctx.provider, ctx.response.costUSD);
      }
    },
    
    // PII redaction middleware
    async (ctx, next) => {
      // Redact sensitive data before sending to providers
      ctx.request.messages = redactPII(ctx.request.messages);
      await next();
    }
  ]
});
```

### Rate Limiting

Control request rates per provider/model:

```typescript
const feather = new Feather({
  providers: { /* ... */ },
  limits: {
    "openai:gpt-4": { rps: 10, burst: 20 },      // 10 req/sec, burst to 20
    "openai:gpt-3.5-turbo": { rps: 50, burst: 100 },
    "anthropic:claude-3-5-haiku": { rps: 5, burst: 10 }
  }
});
```

### Retry Configuration

Customize retry behavior:

```typescript
const feather = new Feather({
  providers: { /* ... */ },
  retry: {
    maxAttempts: 3,        // Try up to 3 times
    baseMs: 1000,         // Start with 1 second delay
    maxMs: 10000,         // Max 10 second delay
    jitter: "full"        // Add randomness to prevent thundering herd
  }
});
```

### Circuit Breaker

Automatic failure detection and recovery:

```typescript
// Circuit breaker is automatically enabled
// After 5 failures, provider is temporarily disabled
// Automatically re-enabled after 5 seconds
```

## 🛠️ Adding Custom Providers

Create providers for any LLM service:

```typescript
import { ChatProvider } from "feather-orchestrator";

export function customProvider(config: { apiKey: string }): ChatProvider {
  return {
    id: "custom",
    
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const response = await fetch("https://api.custom-llm.com/chat", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens
        })
      });
      
      if (!response.ok) {
        throw new Error(`Custom API error: ${response.status}`);
      }
      
      const data = await response.json();
      return {
        content: data.choices[0].message.content,
        tokens: {
          input: data.usage.prompt_tokens,
          output: data.usage.completion_tokens
        },
        costUSD: calculateCost(data.usage),
        raw: data
      };
    },
    
    async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
      // Implement streaming if supported
      const response = await fetch("https://api.custom-llm.com/chat/stream", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true
        })
      });
      
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      
      while (true) {
        const { value, done } = await reader!.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta?.content) {
              yield { content: data.choices[0].delta.content };
            }
          }
        }
      }
    },
    
    price: {
      inputPer1K: 0.001,   // $0.001 per 1K input tokens
      outputPer1K: 0.002  // $0.002 per 1K output tokens
    }
  };
}

// Use your custom provider
const feather = new Feather({
  providers: {
    custom: customProvider({ apiKey: "your-api-key" })
  }
});
```

## 🖥️ CLI Usage

Install globally or use with npx:

```bash
# Install globally
npm install -g feather-orchestrator

# Use with npx
npx feather chat -m gpt-4 -q "What is machine learning?"

# With specific provider
npx feather chat -p openai -m gpt-4 -q "Hello world"

# With config file
npx feather chat -c ./my-config.json -m fast -q "Explain AI"
```

### CLI Options

```bash
feather chat [options]

Options:
  -p, --provider <provider>  Provider name (optional with config)
  -m, --model <model>        Model name or alias
  -q, --query <query>        User message
  -c, --config <file>        Config file path (default: feather.config.json)
  -h, --help                 Show help
```

## 🔧 Configuration Reference

### `feather.config.json`

```json
{
  "policy": "cheapest",           // "cheapest" | "roundrobin" | "first"
  "providers": {
    "provider-name": {
      "apiKeyEnv": "API_KEY_ENV_VAR",
      "baseUrl": "https://api.provider.com",  // Optional custom base URL
      "models": [
        {
          "name": "model-name",               // Provider's model name
          "aliases": ["alias1", "alias2"],   // Your semantic names
          "inputPer1K": 0.001,              // Cost per 1K input tokens
          "outputPer1K": 0.002              // Cost per 1K output tokens
        }
      ]
    }
  }
}
```

### Environment Variables

```bash
# Required for providers
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Custom base URLs
OPENAI_BASE_URL=https://api.openai.com/v1
ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
```

## 🤖 Agent Chaining Patterns

Feather Orchestrator excels at chaining multiple agents together for complex workflows. Here are the main patterns:

### Sequential Agent Chain

```typescript
// Chain agents in sequence, passing output from one to the next
const feather = new Feather({
  providers: {
    researcher: openai({ apiKey: process.env.OPENAI_API_KEY! }),
    writer: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    reviewer: openai({ apiKey: process.env.OPENAI_API_KEY! })
  }
});

// Step 1: Research
const research = await feather.chat({
  provider: "researcher",
  model: "gpt-4",
  messages: [{ role: "user", content: "Research quantum computing" }]
});

// Step 2: Write based on research
const article = await feather.chat({
  provider: "writer",
  model: "claude-3-5-haiku",
  messages: [
    { role: "user", content: `Write an article based on: ${research.content}` }
  ]
});

// Step 3: Review the article
const review = await feather.chat({
  provider: "reviewer",
  model: "gpt-4",
  messages: [
    { role: "user", content: `Review this article: ${article.content}` }
  ]
});
```

### Conditional Agent Chain

```typescript
// Route to different agents based on conditions
const feather = new Feather({
  providers: {
    classifier: openai({ apiKey: process.env.OPENAI_API_KEY! }),
    technical: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    creative: openai({ apiKey: process.env.OPENAI_API_KEY! })
  }
});

// Step 1: Classify the query
const classification = await feather.chat({
  provider: "classifier",
  model: "gpt-3.5-turbo",
  messages: [{ role: "user", content: "Classify: How do neural networks work?" }]
});

// Step 2: Route to appropriate agent
let response;
if (classification.content.includes('technical')) {
  response = await feather.chat({
    provider: "technical",
    model: "claude-3-5-haiku",
    messages: [{ role: "user", content: "How do neural networks work?" }]
  });
} else {
  response = await feather.chat({
    provider: "creative",
    model: "gpt-4",
    messages: [{ role: "user", content: "How do neural networks work?" }]
  });
}
```

### Parallel Agent Chain

```typescript
// Run multiple agents in parallel, then aggregate results
const feather = new Feather({
  providers: {
    analyst: openai({ apiKey: process.env.OPENAI_API_KEY! }),
    strategist: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    critic: openai({ apiKey: process.env.OPENAI_API_KEY! })
  }
});

// Run all agents in parallel
const [analysis, strategy, critique] = await Promise.all([
  feather.chat({
    provider: "analyst",
    model: "gpt-4",
    messages: [{ role: "user", content: "Analyze our business problem" }]
  }),
  feather.chat({
    provider: "strategist",
    model: "claude-3-5-haiku",
    messages: [{ role: "user", content: "Provide strategic solutions" }]
  }),
  feather.chat({
    provider: "critic",
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: "Identify potential risks" }]
  })
]);

// Aggregate all perspectives
const synthesis = await feather.chat({
  provider: "analyst",
  model: "gpt-4",
  messages: [{
    role: "user",
    content: `Synthesize these perspectives:\nAnalysis: ${analysis.content}\nStrategy: ${strategy.content}\nCritique: ${critique.content}`
  }]
});
```

### Iterative Agent Chain (Feedback Loop)

```typescript
// Iterative improvement with feedback
const feather = new Feather({
  providers: {
    generator: openai({ apiKey: process.env.OPENAI_API_KEY! }),
    evaluator: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    improver: openai({ apiKey: process.env.OPENAI_API_KEY! })
  }
});

let solution = "";
const maxIterations = 3;

for (let i = 1; i <= maxIterations; i++) {
  if (i === 1) {
    // Generate initial solution
    const generatorResponse = await feather.chat({
      provider: "generator",
      model: "gpt-4",
      messages: [{ role: "user", content: "Write a Python function for Fibonacci" }]
    });
    solution = generatorResponse.content;
  } else {
    // Evaluate current solution
    const evaluation = await feather.chat({
      provider: "evaluator",
      model: "claude-3-5-haiku",
      messages: [{
        role: "user",
        content: `Review this code: ${solution}`
      }]
    });
    
    // Improve based on feedback
    const improvement = await feather.chat({
      provider: "improver",
      model: "gpt-4",
      messages: [{
        role: "user",
        content: `Improve this code based on feedback:\nCode: ${solution}\nFeedback: ${evaluation.content}`
      }]
    });
    
    solution = improvement.content;
  }
}
```

### Agent Chain with Fallback

```typescript
// Chain with automatic fallback if agents fail
const feather = new Feather({
  providers: {
    primary: openai({ apiKey: process.env.OPENAI_API_KEY! }),
    backup: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    emergency: openai({ apiKey: process.env.OPENAI_API_KEY! })
  }
});

let response;
try {
  // Try primary agent
  response = await feather.chat({
    provider: "primary",
    model: "gpt-4",
    messages: [{ role: "user", content: "Complex task" }]
  });
} catch (primaryError) {
  try {
    // Try backup agent
    response = await feather.chat({
      provider: "backup",
      model: "claude-3-5-haiku",
      messages: [{ role: "user", content: "Complex task" }]
    });
  } catch (backupError) {
    // Use emergency fallback
    response = await feather.chat({
      provider: "emergency",
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: "Complex task" }]
    });
  }
}
```

## 🏗️ Real-World Examples

### Production Application

```typescript
import { Feather, openai, anthropic } from "feather-orchestrator";

class ChatService {
  private feather: Feather;
  
  constructor() {
    this.feather = new Feather({
      providers: {
        primary: openai({ 
          apiKey: process.env.OPENAI_API_KEY!,
          pricing: { inputPer1K: 0.03, outputPer1K: 0.06 }
        }),
        backup: anthropic({ 
          apiKey: process.env.ANTHROPIC_API_KEY!,
          pricing: { inputPer1K: 0.008, outputPer1K: 0.024 }
        })
      },
      limits: {
        "openai:gpt-4": { rps: 100, burst: 200 },
        "anthropic:claude-3-5-haiku": { rps: 50, burst: 100 }
      },
      retry: { maxAttempts: 3, baseMs: 1000, maxMs: 5000 },
      timeoutMs: 30000,
      middleware: [
        this.loggingMiddleware,
        this.costTrackingMiddleware,
        this.piiRedactionMiddleware
      ]
    });
  }
  
  async chat(messages: Message[], options?: ChatOptions) {
    // Automatic failover with cost optimization
    const fallbackChain = this.feather.fallback([
      { provider: "primary", model: "gpt-4" },
      { provider: "backup", model: "claude-3-5-haiku" },
      { provider: "primary", model: "gpt-3.5-turbo" }
    ]);
    
    return await fallbackChain.chat({
      messages,
      temperature: options?.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? 1000
    });
  }
  
  private loggingMiddleware = async (ctx: any, next: () => Promise<void>) => {
    console.log(`[${new Date().toISOString()}] Request to ${ctx.provider}:${ctx.model}`);
    const start = Date.now();
    await next();
    console.log(`[${new Date().toISOString()}] Response in ${Date.now() - start}ms`);
  };
  
  private costTrackingMiddleware = async (ctx: any, next: () => Promise<void>) => {
    await next();
    if (ctx.response?.costUSD) {
      // Send to your metrics system
      await this.metricsService.recordCost({
        provider: ctx.provider,
        model: ctx.model,
        cost: ctx.response.costUSD,
        timestamp: new Date()
      });
    }
  };
  
  private piiRedactionMiddleware = async (ctx: any, next: () => Promise<void>) => {
    // Redact PII before sending to providers
    ctx.request.messages = this.redactPII(ctx.request.messages);
    await next();
  };
}
```

### Batch Processing

```typescript
async function processBatch(items: string[]) {
  const feather = new Feather({
    providers: {
      openai: openai({ apiKey: process.env.OPENAI_API_KEY! })
    }
  });
  
  const results = await feather.map(
    items,
    async (item) => {
      const response = await feather.chat({
        provider: "openai",
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: `Process this: ${item}` }
        ],
        maxTokens: 200
      });
      
      return {
        input: item,
        output: response.content,
        cost: response.costUSD
      };
    },
    { concurrency: 5 }  // Process 5 items simultaneously
  );
  
  const totalCost = results.reduce((sum, r) => sum + (r.cost || 0), 0);
  console.log(`Processed ${results.length} items for $${totalCost.toFixed(6)}`);
  
  return results;
}
```

### A/B Testing

```typescript
async function abTest(prompt: string) {
  const feather = new Feather({
    providers: {
      openai: openai({ apiKey: process.env.OPENAI_API_KEY! }),
      anthropic: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    }
  });
  
  // Race different models to compare performance
  const raceChain = feather.race([
    { provider: "openai", model: "gpt-4" },
    { provider: "anthropic", model: "claude-3-5-haiku" }
  ]);
  
  const startTime = Date.now();
  const response = await raceChain.chat({
    messages: [{ role: "user", content: prompt }]
  });
  const duration = Date.now() - startTime;
  
  console.log(`Winner: ${response.provider} (${duration}ms)`);
  console.log(`Response: ${response.content}`);
  
  return { response, duration };
}
```

## 🔒 Security Best Practices

### API Key Management

```typescript
// ✅ Good: Use environment variables
const feather = new Feather({
  providers: {
    openai: openai({ apiKey: process.env.OPENAI_API_KEY! })
  }
});

// ❌ Bad: Hardcode API keys
const feather = new Feather({
  providers: {
    openai: openai({ apiKey: "sk-1234567890abcdef" })
  }
});
```

### PII Redaction

```typescript
const feather = new Feather({
  providers: { /* ... */ },
  middleware: [
    async (ctx, next) => {
      // Redact sensitive information
      ctx.request.messages = ctx.request.messages.map(msg => ({
        ...msg,
        content: msg.content
          .replace(/\b\d{4}-\d{4}-\d{4}-\d{4}\b/g, '[CARD]')  // Credit cards
          .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]')         // SSNs
          .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL]')  // Emails
      }));
      await next();
    }
  ]
});
```

### Rate Limiting

```typescript
// Prevent abuse with strict rate limits
const feather = new Feather({
  providers: { /* ... */ },
  limits: {
    "openai:gpt-4": { rps: 1, burst: 2 },  // Very conservative limits
    "anthropic:claude-3-5-haiku": { rps: 2, burst: 3 }
  }
});
```

## 🧪 Testing

### Unit Tests

```typescript
import { describe, it, expect, vi } from "vitest";
import { Feather } from "feather-orchestrator";

describe("Feather Orchestrator", () => {
  it("should handle fallback correctly", async () => {
    const mockProvider = {
      id: "mock",
      async chat() {
        throw new Error("Provider failed");
      }
    };
    
    const feather = new Feather({
      providers: {
        fail: mockProvider,
        success: {
          id: "success",
          async chat() {
            return { content: "Success!" };
          }
        }
      }
    });
    
    const fallbackChain = feather.fallback([
      { provider: "fail", model: "test" },
      { provider: "success", model: "test" }
    ]);
    
    const response = await fallbackChain.chat({
      messages: [{ role: "user", content: "test" }]
    });
    
    expect(response.content).toBe("Success!");
  });
});
```

### Integration Tests

```typescript
import { Feather, openai } from "feather-orchestrator";

describe("Integration Tests", () => {
  it("should work with real OpenAI API", async () => {
    const feather = new Feather({
      providers: {
        openai: openai({ apiKey: process.env.OPENAI_API_KEY! })
      }
    });
    
    const response = await feather.chat({
      provider: "openai",
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: "Say hello" }]
    });
    
    expect(response.content).toContain("hello");
    expect(response.costUSD).toBeGreaterThan(0);
  });
});
```

## 📊 Monitoring & Observability

### Cost Tracking

```typescript
class CostTracker {
  private costs: Map<string, number> = new Map();
  
  async trackCost(provider: string, cost: number) {
    const current = this.costs.get(provider) || 0;
    this.costs.set(provider, current + cost);
    
    // Send to your metrics system
    await this.sendToMetrics({
      provider,
      cost,
      total: current + cost,
      timestamp: new Date()
    });
  }
  
  getTotalCost(): number {
    return Array.from(this.costs.values()).reduce((sum, cost) => sum + cost, 0);
  }
  
  getCostByProvider(): Record<string, number> {
    return Object.fromEntries(this.costs);
  }
}

const costTracker = new CostTracker();

const feather = new Feather({
  providers: { /* ... */ },
  middleware: [
    async (ctx, next) => {
      await next();
      if (ctx.response?.costUSD) {
        await costTracker.trackCost(ctx.provider, ctx.response.costUSD);
      }
    }
  ]
});
```

### Performance Monitoring

```typescript
class PerformanceMonitor {
  private metrics: Array<{
    provider: string;
    model: string;
    duration: number;
    success: boolean;
    timestamp: Date;
  }> = [];
  
  async trackRequest(provider: string, model: string, duration: number, success: boolean) {
    this.metrics.push({
      provider,
      model,
      duration,
      success,
      timestamp: new Date()
    });
    
    // Send to your monitoring system
    await this.sendToMonitoring({
      provider,
      model,
      duration,
      success,
      timestamp: new Date()
    });
  }
  
  getAverageResponseTime(provider?: string): number {
    const filtered = provider 
      ? this.metrics.filter(m => m.provider === provider)
      : this.metrics;
    
    if (filtered.length === 0) return 0;
    
    const total = filtered.reduce((sum, m) => sum + m.duration, 0);
    return total / filtered.length;
  }
  
  getSuccessRate(provider?: string): number {
    const filtered = provider 
      ? this.metrics.filter(m => m.provider === provider)
      : this.metrics;
    
    if (filtered.length === 0) return 0;
    
    const successful = filtered.filter(m => m.success).length;
    return successful / filtered.length;
  }
}

const performanceMonitor = new PerformanceMonitor();

const feather = new Feather({
  providers: { /* ... */ },
  middleware: [
    async (ctx, next) => {
      const start = Date.now();
      let success = true;
      
      try {
        await next();
      } catch (error) {
        success = false;
        throw error;
      } finally {
        const duration = Date.now() - start;
        await performanceMonitor.trackRequest(
          ctx.provider,
          ctx.model,
          duration,
          success
        );
      }
    }
  ]
});
```

## 🚀 Deployment

### Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

### Environment Variables

```bash
# Production environment
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Custom configurations
FEATHER_CONFIG_PATH=/app/config/feather.config.json
FEATHER_LOG_LEVEL=info
FEATHER_RATE_LIMIT_ENABLED=true
```

### Kubernetes ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: feather-config
data:
  feather.config.json: |
    {
      "policy": "cheapest",
      "providers": {
        "openai": {
          "apiKeyEnv": "OPENAI_API_KEY",
          "models": [
            {
              "name": "gpt-4",
              "aliases": ["smart"],
              "inputPer1K": 0.03,
              "outputPer1K": 0.06
            }
          ]
        }
      }
    }
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Adding New Providers

1. Create a new file in `src/providers/`
2. Implement the `ChatProvider` interface
3. Add tests in `tests/providers/`
4. Update the README with usage examples

## 📄 License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- Built with ❤️ for the developer community
- Inspired by the need for reliable LLM orchestration
- Thanks to all contributors and users

---

**Need help?** Open an issue on [GitHub](https://github.com/your-username/feather-orchestrator/issues) or check the [documentation](https://github.com/your-username/feather-orchestrator#readme).