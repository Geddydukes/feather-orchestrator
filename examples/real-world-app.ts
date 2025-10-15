#!/usr/bin/env node
/**
 * Real-world application example using Feather Orchestrator
 * This demonstrates how to use the orchestrator in a production application
 */

import { Feather, openai, anthropic, buildRegistry } from "../src/index.js";

// Example 1: Basic multi-provider setup with fallback
async function basicOrchestration() {
  console.log("🚀 Basic Orchestration Example");
  
  const feather = new Feather({
    providers: {
      openai: openai({ 
        apiKey: process.env.OPENAI_API_KEY!,
        pricing: { inputPer1K: 0.005, outputPer1K: 0.015 }
      }),
      anthropic: anthropic({ 
        apiKey: process.env.ANTHROPIC_API_KEY!,
        pricing: { inputPer1K: 0.008, outputPer1K: 0.024 }
      })
    },
    limits: {
      "openai:gpt-4": { rps: 5, burst: 10 },
      "anthropic:claude-3-5-haiku": { rps: 3, burst: 5 }
    },
    retry: { maxAttempts: 3, baseMs: 1000, maxMs: 5000 },
    timeoutMs: 30000
  });

  // Fallback chain - try OpenAI first, then Anthropic
  const fallbackChain = feather.fallback([
    { provider: "openai", model: "gpt-4" },
    { provider: "anthropic", model: "claude-3-5-haiku" }
  ]);

  try {
    const response = await fallbackChain.chat({
      messages: [
        { role: "system", content: "You are a helpful assistant that explains complex topics simply." },
        { role: "user", content: "Explain quantum computing in 2 sentences." }
      ],
      temperature: 0.7,
      maxTokens: 200
    });

    console.log("✅ Response:", response.content);
    console.log("💰 Cost: $", response.costUSD);
    console.log("📊 Tokens:", response.tokens);
  } catch (error) {
    console.error("❌ All providers failed:", error);
  }
}

// Example 2: Race multiple providers for speed
async function raceProviders() {
  console.log("\n🏁 Race Providers Example");
  
  const feather = new Feather({
    providers: {
      openai: openai({ apiKey: process.env.OPENAI_API_KEY! }),
      anthropic: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    }
  });

  const raceChain = feather.race([
    { provider: "openai", model: "gpt-4" },
    { provider: "anthropic", model: "claude-3-5-haiku" }
  ]);

  try {
    const startTime = Date.now();
    const response = await raceChain.chat({
      messages: [{ role: "user", content: "What's 2+2?" }]
    });
    const duration = Date.now() - startTime;
    
    console.log("✅ Fastest response:", response.content);
    console.log("⏱️ Response time:", duration, "ms");
  } catch (error) {
    console.error("❌ Race failed:", error);
  }
}

// Example 3: Streaming with middleware
async function streamingWithMiddleware() {
  console.log("\n🌊 Streaming with Middleware Example");
  
  const feather = new Feather({
    providers: {
      openai: openai({ apiKey: process.env.OPENAI_API_KEY! })
    },
    middleware: [
      // Logging middleware
      async (ctx, next) => {
        console.log(`📝 Request to ${ctx.provider}:${ctx.model}`);
        await next();
        console.log(`✅ Response from ${ctx.provider} (${ctx.endTs! - ctx.startTs}ms)`);
      },
      // Cost tracking middleware
      async (ctx, next) => {
        await next();
        if (ctx.response?.costUSD) {
          console.log(`💰 Cost: $${ctx.response.costUSD.toFixed(6)}`);
        }
      }
    ]
  });

  try {
    console.log("Streaming response:");
    for await (const delta of feather.stream.chat({
      provider: "openai",
      model: "gpt-4",
      messages: [{ role: "user", content: "Write a haiku about coding." }]
    })) {
      process.stdout.write(delta.content || "");
    }
    console.log("\n");
  } catch (error) {
    console.error("❌ Streaming failed:", error);
  }
}

// Example 4: Configuration-driven setup
async function configDrivenSetup() {
  console.log("\n⚙️ Configuration-Driven Setup");
  
  // This would typically load from feather.config.json
  const config = {
    policy: "cheapest" as const,
    providers: {
      openai: {
        apiKeyEnv: "OPENAI_API_KEY",
        models: [
          { 
            name: "gpt-4", 
            aliases: ["smart", "expensive"], 
            inputPer1K: 0.03, 
            outputPer1K: 0.06 
          },
          { 
            name: "gpt-3.5-turbo", 
            aliases: ["fast", "cheap"], 
            inputPer1K: 0.001, 
            outputPer1K: 0.002 
          }
        ]
      },
      anthropic: {
        apiKeyEnv: "ANTHROPIC_API_KEY",
        models: [
          { 
            name: "claude-3-5-haiku", 
            aliases: ["fast", "balanced"], 
            inputPer1K: 0.008, 
            outputPer1K: 0.024 
          }
        ]
      }
    }
  };

  const registry = buildRegistry(config);
  const feather = new Feather({ registry });

  try {
    // Use semantic model names
    const response = await feather.chat({
      model: "fast", // Will pick the cheapest "fast" model
      messages: [{ role: "user", content: "Hello!" }]
    });
    
    console.log("✅ Response:", response.content);
  } catch (error) {
    console.error("❌ Config-driven setup failed:", error);
  }
}

// Example 5: Batch processing with concurrency control
async function batchProcessing() {
  console.log("\n📦 Batch Processing Example");
  
  const feather = new Feather({
    providers: {
      openai: openai({ apiKey: process.env.OPENAI_API_KEY! })
    }
  });

  const prompts = [
    "Explain machine learning",
    "What is React?",
    "How does HTTP work?",
    "Describe cloud computing"
  ];

  try {
    const results = await feather.map(
      prompts,
      async (prompt) => {
        const response = await feather.chat({
          provider: "openai",
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: prompt }],
          maxTokens: 100
        });
        return { prompt, response: response.content };
      },
      { concurrency: 2 } // Process 2 at a time
    );

    console.log("✅ Batch results:");
    results.forEach(({ prompt, response }) => {
      console.log(`📝 ${prompt}: ${response.substring(0, 50)}...`);
    });
  } catch (error) {
    console.error("❌ Batch processing failed:", error);
  }
}

// Main execution
async function main() {
  console.log("🎯 Feather Orchestrator - Real-World Examples\n");
  
  // Check for API keys
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.log("⚠️  Please set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variables");
    console.log("   Example: OPENAI_API_KEY=sk-... npm run examples:real-world");
    return;
  }

  try {
    await basicOrchestration();
    await raceProviders();
    await streamingWithMiddleware();
    await configDrivenSetup();
    await batchProcessing();
    
    console.log("\n🎉 All examples completed successfully!");
  } catch (error) {
    console.error("❌ Example failed:", error);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
