#!/usr/bin/env node
/**
 * Agent Chaining Examples with Feather Orchestrator
 * Demonstrates how to chain multiple agents together for complex workflows
 */

import { Feather, openai, anthropic } from "../src/index.js";

// Example 1: Simple Sequential Agent Chain
async function sequentialAgentChain() {
  console.log("🔗 Sequential Agent Chain Example");
  
  const feather = new Feather({
    providers: {
      researcher: openai({ apiKey: process.env.OPENAI_API_KEY! }),
      writer: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
      reviewer: openai({ apiKey: process.env.OPENAI_API_KEY! })
    }
  });

  const topic = "quantum computing applications in healthcare";
  
  try {
    // Step 1: Research Agent - Gather information
    console.log("🔍 Step 1: Research Agent gathering information...");
    const researchResponse = await feather.chat({
      provider: "researcher",
      model: "gpt-4",
      messages: [
        { 
          role: "system", 
          content: "You are a research assistant. Provide detailed, factual information about the given topic." 
        },
        { 
          role: "user", 
          content: `Research and provide comprehensive information about: ${topic}` 
        }
      ],
      temperature: 0.3,
      maxTokens: 1000
    });
    
    console.log("📊 Research completed:", researchResponse.content.substring(0, 100) + "...");
    
    // Step 2: Writer Agent - Create content based on research
    console.log("✍️ Step 2: Writer Agent creating content...");
    const writerResponse = await feather.chat({
      provider: "writer",
      model: "claude-3-5-haiku",
      messages: [
        { 
          role: "system", 
          content: "You are a technical writer. Create engaging, well-structured content based on research data." 
        },
        { 
          role: "user", 
          content: `Based on this research: "${researchResponse.content}"\n\nCreate a compelling article about ${topic}.` 
        }
      ],
      temperature: 0.7,
      maxTokens: 1500
    });
    
    console.log("📝 Article created:", writerResponse.content.substring(0, 100) + "...");
    
    // Step 3: Reviewer Agent - Review and improve content
    console.log("🔍 Step 3: Reviewer Agent reviewing content...");
    const reviewerResponse = await feather.chat({
      provider: "reviewer",
      model: "gpt-4",
      messages: [
        { 
          role: "system", 
          content: "You are an editor. Review content for accuracy, clarity, and engagement. Provide specific improvements." 
        },
        { 
          role: "user", 
          content: `Please review this article and suggest improvements:\n\n${writerResponse.content}` 
        }
      ],
      temperature: 0.4,
      maxTokens: 800
    });
    
    console.log("✅ Review completed:", reviewerResponse.content.substring(0, 100) + "...");
    
    // Final result
    console.log("\n🎯 Final Chain Result:");
    console.log("Research:", researchResponse.content.substring(0, 200) + "...");
    console.log("Article:", writerResponse.content.substring(0, 200) + "...");
    console.log("Review:", reviewerResponse.content.substring(0, 200) + "...");
    
    const totalCost = (researchResponse.costUSD || 0) + 
                     (writerResponse.costUSD || 0) + 
                     (reviewerResponse.costUSD || 0);
    console.log(`💰 Total Cost: $${totalCost.toFixed(6)}`);
    
  } catch (error) {
    console.error("❌ Chain failed:", error);
  }
}

// Example 2: Conditional Agent Chain (if-then logic)
async function conditionalAgentChain() {
  console.log("\n🔄 Conditional Agent Chain Example");
  
  const feather = new Feather({
    providers: {
      classifier: openai({ apiKey: process.env.OPENAI_API_KEY! }),
      technical: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
      creative: openai({ apiKey: process.env.OPENAI_API_KEY! })
    }
  });

  const userQuery = "How do I implement a neural network from scratch?";
  
  try {
    // Step 1: Classifier Agent - Determine query type
    console.log("🏷️ Step 1: Classifying query type...");
    const classificationResponse = await feather.chat({
      provider: "classifier",
      model: "gpt-3.5-turbo",
      messages: [
        { 
          role: "system", 
          content: "You are a query classifier. Respond with only: 'technical', 'creative', or 'general'" 
        },
        { 
          role: "user", 
          content: `Classify this query: "${userQuery}"` 
        }
      ],
      temperature: 0.1,
      maxTokens: 10
    });
    
    const queryType = classificationResponse.content.toLowerCase().trim();
    console.log(`📋 Query classified as: ${queryType}`);
    
    // Step 2: Route to appropriate agent based on classification
    let response;
    if (queryType.includes('technical')) {
      console.log("🔧 Routing to Technical Agent...");
      response = await feather.chat({
        provider: "technical",
        model: "claude-3-5-haiku",
        messages: [
          { 
            role: "system", 
            content: "You are a technical expert. Provide detailed, accurate technical explanations with code examples." 
          },
          { 
            role: "user", 
            content: userQuery 
          }
        ],
        temperature: 0.3,
        maxTokens: 2000
      });
    } else if (queryType.includes('creative')) {
      console.log("🎨 Routing to Creative Agent...");
      response = await feather.chat({
        provider: "creative",
        model: "gpt-4",
        messages: [
          { 
            role: "system", 
            content: "You are a creative assistant. Provide imaginative, engaging responses with creative examples." 
          },
          { 
            role: "user", 
            content: userQuery 
          }
        ],
        temperature: 0.8,
        maxTokens: 1500
      });
    } else {
      console.log("📚 Routing to General Agent...");
      response = await feather.chat({
        provider: "classifier",
        model: "gpt-3.5-turbo",
        messages: [
          { 
            role: "system", 
            content: "You are a helpful general assistant. Provide clear, informative responses." 
          },
          { 
            role: "user", 
            content: userQuery 
          }
        ],
        temperature: 0.5,
        maxTokens: 1000
      });
    }
    
    console.log("✅ Response:", response.content.substring(0, 200) + "...");
    
  } catch (error) {
    console.error("❌ Conditional chain failed:", error);
  }
}

// Example 3: Parallel Agent Chain with Aggregation
async function parallelAgentChain() {
  console.log("\n⚡ Parallel Agent Chain Example");
  
  const feather = new Feather({
    providers: {
      analyst: openai({ apiKey: process.env.OPENAI_API_KEY! }),
      strategist: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
      critic: openai({ apiKey: process.env.OPENAI_API_KEY! })
    }
  });

  const businessProblem = "Our SaaS startup is struggling with customer retention";
  
  try {
    // Step 1: Run multiple agents in parallel
    console.log("🚀 Running multiple agents in parallel...");
    
    const [analystResponse, strategistResponse, criticResponse] = await Promise.all([
      // Analyst Agent
      feather.chat({
        provider: "analyst",
        model: "gpt-4",
        messages: [
          { 
            role: "system", 
            content: "You are a business analyst. Analyze problems and provide data-driven insights." 
          },
          { 
            role: "user", 
            content: `Analyze this business problem: ${businessProblem}` 
          }
        ],
        temperature: 0.3,
        maxTokens: 800
      }),
      
      // Strategist Agent
      feather.chat({
        provider: "strategist",
        model: "claude-3-5-haiku",
        messages: [
          { 
            role: "system", 
            content: "You are a business strategist. Provide strategic recommendations and action plans." 
          },
          { 
            role: "user", 
            content: `Provide strategic solutions for: ${businessProblem}` 
          }
        ],
        temperature: 0.5,
        maxTokens: 1000
      }),
      
      // Critic Agent
      feather.chat({
        provider: "critic",
        model: "gpt-3.5-turbo",
        messages: [
          { 
            role: "system", 
            content: "You are a business critic. Identify potential risks and challenges in proposed solutions." 
          },
          { 
            role: "user", 
            content: `Critically evaluate solutions for: ${businessProblem}` 
          }
        ],
        temperature: 0.4,
        maxTokens: 600
      })
    ]);
    
    console.log("📊 Analysis:", analystResponse.content.substring(0, 150) + "...");
    console.log("🎯 Strategy:", strategistResponse.content.substring(0, 150) + "...");
    console.log("⚠️ Critique:", criticResponse.content.substring(0, 150) + "...");
    
    // Step 2: Aggregator Agent - Combine all perspectives
    console.log("🔄 Aggregating all perspectives...");
    const aggregatorResponse = await feather.chat({
      provider: "analyst",
      model: "gpt-4",
      messages: [
        { 
          role: "system", 
          content: "You are a business consultant. Synthesize multiple perspectives into a comprehensive solution." 
        },
        { 
          role: "user", 
          content: `Synthesize these different perspectives on "${businessProblem}":\n\nAnalysis: ${analystResponse.content}\n\nStrategy: ${strategistResponse.content}\n\nCritique: ${criticResponse.content}\n\nProvide a comprehensive solution that addresses all concerns.` 
        }
      ],
      temperature: 0.4,
      maxTokens: 1500
    });
    
    console.log("🎯 Final Comprehensive Solution:");
    console.log(aggregatorResponse.content);
    
    const totalCost = (analystResponse.costUSD || 0) + 
                     (strategistResponse.costUSD || 0) + 
                     (criticResponse.costUSD || 0) + 
                     (aggregatorResponse.costUSD || 0);
    console.log(`💰 Total Cost: $${totalCost.toFixed(6)}`);
    
  } catch (error) {
    console.error("❌ Parallel chain failed:", error);
  }
}

// Example 4: Iterative Agent Chain (feedback loop)
async function iterativeAgentChain() {
  console.log("\n🔄 Iterative Agent Chain Example");
  
  const feather = new Feather({
    providers: {
      generator: openai({ apiKey: process.env.OPENAI_API_KEY! }),
      evaluator: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
      improver: openai({ apiKey: process.env.OPENAI_API_KEY! })
    }
  });

  const task = "Write a Python function to calculate Fibonacci numbers";
  const maxIterations = 3;
  
  try {
    let currentSolution = "";
    let iteration = 1;
    
    while (iteration <= maxIterations) {
      console.log(`🔄 Iteration ${iteration}:`);
      
      if (iteration === 1) {
        // Step 1: Generator Agent - Create initial solution
        console.log("💡 Generating initial solution...");
        const generatorResponse = await feather.chat({
          provider: "generator",
          model: "gpt-4",
          messages: [
            { 
              role: "system", 
              content: "You are a Python developer. Write clean, efficient code with proper documentation." 
            },
            { 
              role: "user", 
              content: task 
            }
          ],
          temperature: 0.3,
          maxTokens: 1000
        });
        
        currentSolution = generatorResponse.content;
        console.log("📝 Initial solution:", currentSolution.substring(0, 200) + "...");
        
      } else {
        // Step 2: Evaluator Agent - Evaluate current solution
        console.log("🔍 Evaluating current solution...");
        const evaluatorResponse = await feather.chat({
          provider: "evaluator",
          model: "claude-3-5-haiku",
          messages: [
            { 
              role: "system", 
              content: "You are a code reviewer. Identify issues, inefficiencies, and areas for improvement." 
            },
            { 
              role: "user", 
              content: `Review this code and identify specific issues:\n\n${currentSolution}` 
            }
          ],
          temperature: 0.3,
          maxTokens: 800
        });
        
        console.log("📋 Evaluation:", evaluatorResponse.content.substring(0, 200) + "...");
        
        // Step 3: Improver Agent - Improve based on feedback
        console.log("🔧 Improving solution based on feedback...");
        const improverResponse = await feather.chat({
          provider: "improver",
          model: "gpt-4",
          messages: [
            { 
              role: "system", 
              content: "You are a senior Python developer. Improve code based on specific feedback and best practices." 
            },
            { 
              role: "user", 
              content: `Improve this code based on the feedback:\n\nCurrent code:\n${currentSolution}\n\nFeedback:\n${evaluatorResponse.content}` 
            }
          ],
          temperature: 0.2,
          maxTokens: 1200
        });
        
        currentSolution = improverResponse.content;
        console.log("✨ Improved solution:", currentSolution.substring(0, 200) + "...");
      }
      
      iteration++;
    }
    
    console.log("🎯 Final Iterative Solution:");
    console.log(currentSolution);
    
  } catch (error) {
    console.error("❌ Iterative chain failed:", error);
  }
}

// Example 5: Agent Chain with Fallback
async function agentChainWithFallback() {
  console.log("\n🛡️ Agent Chain with Fallback Example");
  
  const feather = new Feather({
    providers: {
      primary: openai({ apiKey: process.env.OPENAI_API_KEY! }),
      backup: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
      emergency: openai({ apiKey: process.env.OPENAI_API_KEY! })
    }
  });

  const complexTask = "Design a microservices architecture for an e-commerce platform";
  
  try {
    // Step 1: Primary Agent Chain
    console.log("🎯 Running primary agent chain...");
    
    let response;
    try {
      // Try primary agent first
      response = await feather.chat({
        provider: "primary",
        model: "gpt-4",
        messages: [
          { 
            role: "system", 
            content: "You are a senior software architect. Design comprehensive, scalable architectures." 
          },
          { 
            role: "user", 
            content: complexTask 
          }
        ],
        temperature: 0.4,
        maxTokens: 2000
      });
      
      console.log("✅ Primary agent succeeded");
      
    } catch (primaryError) {
      console.log("⚠️ Primary agent failed, trying backup...");
      
      // Step 2: Backup Agent Chain
      try {
        response = await feather.chat({
          provider: "backup",
          model: "claude-3-5-haiku",
          messages: [
            { 
              role: "system", 
              content: "You are a software architect. Design practical, well-structured architectures." 
            },
            { 
              role: "user", 
              content: complexTask 
            }
          ],
          temperature: 0.5,
          maxTokens: 1500
        });
        
        console.log("✅ Backup agent succeeded");
        
      } catch (backupError) {
        console.log("🚨 Backup agent failed, using emergency fallback...");
        
        // Step 3: Emergency Fallback
        response = await feather.chat({
          provider: "emergency",
          model: "gpt-3.5-turbo",
          messages: [
            { 
              role: "system", 
              content: "You are a software developer. Provide basic architectural guidance." 
            },
            { 
              role: "user", 
              content: `Provide a basic solution for: ${complexTask}` 
            }
          ],
          temperature: 0.6,
          maxTokens: 1000
        });
        
        console.log("✅ Emergency fallback succeeded");
      }
    }
    
    console.log("🎯 Final Architecture Design:");
    console.log(response.content);
    
  } catch (error) {
    console.error("❌ All agents failed:", error);
  }
}

// Example 6: Agent Chain with Context Passing
async function contextPassingChain() {
  console.log("\n📋 Context Passing Chain Example");
  
  const feather = new Feather({
    providers: {
      planner: openai({ apiKey: process.env.OPENAI_API_KEY! }),
      executor: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
      validator: openai({ apiKey: process.env.OPENAI_API_KEY! })
    }
  });

  const projectGoal = "Build a REST API for a task management system";
  
  try {
    // Step 1: Planner Agent - Create detailed plan
    console.log("📋 Planning phase...");
    const plannerResponse = await feather.chat({
      provider: "planner",
      model: "gpt-4",
      messages: [
        { 
          role: "system", 
          content: "You are a project planner. Create detailed, step-by-step implementation plans." 
        },
        { 
          role: "user", 
          content: `Create a detailed implementation plan for: ${projectGoal}` 
        }
      ],
      temperature: 0.3,
      maxTokens: 1500
    });
    
    const plan = plannerResponse.content;
    console.log("📋 Plan created:", plan.substring(0, 200) + "...");
    
    // Step 2: Executor Agent - Implement based on plan
    console.log("🔨 Execution phase...");
    const executorResponse = await feather.chat({
      provider: "executor",
      model: "claude-3-5-haiku",
      messages: [
        { 
          role: "system", 
          content: "You are a software developer. Implement solutions based on detailed plans." 
        },
        { 
          role: "user", 
          content: `Based on this plan, implement the solution:\n\nPlan:\n${plan}\n\nGoal: ${projectGoal}` 
        }
      ],
      temperature: 0.2,
      maxTokens: 2000
    });
    
    const implementation = executorResponse.content;
    console.log("🔨 Implementation completed:", implementation.substring(0, 200) + "...");
    
    // Step 3: Validator Agent - Validate implementation against plan
    console.log("✅ Validation phase...");
    const validatorResponse = await feather.chat({
      provider: "validator",
      model: "gpt-4",
      messages: [
        { 
          role: "system", 
          content: "You are a code validator. Check if implementation matches the plan and identify any gaps." 
        },
        { 
          role: "user", 
          content: `Validate this implementation against the original plan:\n\nOriginal Plan:\n${plan}\n\nImplementation:\n${implementation}\n\nGoal: ${projectGoal}` 
        }
      ],
      temperature: 0.3,
      maxTokens: 1000
    });
    
    console.log("✅ Validation completed:", validatorResponse.content.substring(0, 200) + "...");
    
    // Final summary
    console.log("\n🎯 Context Passing Chain Summary:");
    console.log("📋 Plan:", plan.substring(0, 300) + "...");
    console.log("🔨 Implementation:", implementation.substring(0, 300) + "...");
    console.log("✅ Validation:", validatorResponse.content.substring(0, 300) + "...");
    
  } catch (error) {
    console.error("❌ Context passing chain failed:", error);
  }
}

// Main execution
async function main() {
  console.log("🤖 Feather Orchestrator - Agent Chaining Examples\n");
  
  // Check for API keys
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.log("⚠️  Please set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variables");
    console.log("   Example: OPENAI_API_KEY=sk-... npm run examples:agent-chaining");
    return;
  }

  try {
    await sequentialAgentChain();
    await conditionalAgentChain();
    await parallelAgentChain();
    await iterativeAgentChain();
    await agentChainWithFallback();
    await contextPassingChain();
    
    console.log("\n🎉 All agent chaining examples completed successfully!");
  } catch (error) {
    console.error("❌ Example failed:", error);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
