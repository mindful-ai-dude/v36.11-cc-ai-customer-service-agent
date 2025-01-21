import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import { retrieveContext, RAGSource } from "@/app/lib/utils";
import crypto from "crypto";
import categories from "@/app/lib/customer_support_categories.json";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Debug message helper function
// Input: message string and optional data object
// Output: JSON string with message, sanitized data, and timestamp
const debugMessage = (msg: string, data: any = {}) => {
  console.log(msg, data);
  const timestamp = new Date().toISOString().replace(/[^\x20-\x7E]/g, "");
  const safeData = JSON.parse(JSON.stringify(data));
  return JSON.stringify({ msg, data: safeData, timestamp });
};

// Define the schema for the AI response using Zod
// This ensures type safety and validation for the AI's output
const responseSchema = z.object({
  response: z.string(),
  thinking: z.string(),
  user_mood: z.enum([
    "positive",
    "neutral",
    "negative",
    "curious",
    "frustrated",
    "confused",
  ]),
  suggested_questions: z.array(z.string()),
  debug: z.object({
    context_used: z.boolean(),
  }),
  matched_categories: z.array(z.string()).optional(),
  redirect_to_agent: z
    .object({
      should_redirect: z.boolean(),
      reason: z.string().optional(),
    })
    .optional(),
});

// Helper function to sanitize header values
// Input: string value
// Output: sanitized string (ASCII characters only)
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\x00-\x7F]/g, "");
}

// Helper function to log timestamps for performance measurement
// Input: label string and start time
// Output: Logs the duration for the labeled operation
const logTimestamp = (label: string, start: number) => {
  const timestamp = new Date().toISOString();
  const time = ((performance.now() - start) / 1000).toFixed(2);
  console.log(`⏱️ [${timestamp}] ${label}: ${time}s`);
};

// Main POST request handler
export async function POST(req: Request) {
  const apiStart = performance.now();
  const measureTime = (label: string) => logTimestamp(label, apiStart);

  // Extract data from the request body
  const { messages, model, knowledgeBaseId } = await req.json();
  const latestMessage = messages[messages.length - 1].content;

  console.log("📝 Latest Query:", latestMessage);
  measureTime("User Input Received");

  // Prepare debug data
  const MAX_DEBUG_LENGTH = 1000;
  const debugData = sanitizeHeaderValue(
    debugMessage("🚀 API route called", {
      messagesReceived: messages.length,
      latestMessageLength: latestMessage.length,
      anthropicKeySlice: process.env.ANTHROPIC_API_KEY?.slice(0, 4) + "****",
    }),
  ).slice(0, MAX_DEBUG_LENGTH);

  // Initialize variables for RAG retrieval
  let retrievedContext = "";
  let isRagWorking = false;
  let ragSources: RAGSource[] = [];

  // Attempt to retrieve context from RAG
  try {
    console.log("🔍 Initiating RAG retrieval for query:", latestMessage);
    measureTime("RAG Start");
    const result = await retrieveContext(latestMessage, knowledgeBaseId);
    retrievedContext = result.context;
    isRagWorking = result.isRagWorking;
    ragSources = result.ragSources || [];

    if (!result.isRagWorking) {
      console.warn("🚨 RAG Retrieval failed but did not throw!");
    } else {
      console.log(`📚 Retrieved from: ${result.sourceUsed}`);
    }

    measureTime("RAG Complete");
    console.log("🔍 RAG Retrieved:", isRagWorking ? "YES" : "NO");
    console.log(
      "✅ RAG retrieval completed successfully. Context:",
      retrievedContext.slice(0, 100) + "...",
    );
  } catch (error) {
    console.error("💀 RAG Error:", error);
    console.error("❌ RAG retrieval failed for query:", latestMessage);
    retrievedContext = "";
    isRagWorking = false;
    ragSources = [];
  }

  measureTime("RAG Total Duration");

  // Prepare categories context for the system prompt
  const USE_CATEGORIES = true;
  const categoryListString = categories.categories
    .map((c) => c.id)
    .join(", ");

  const categoriesContext = USE_CATEGORIES
    ? `
    To help with our internal classification of inquiries, we would like you to categorize inquiries in addition to answering them. We have provided you with ${categories.categories.length} customer support categories.
    Check if your response fits into any category and include the category IDs in your "matched_categories" array.
    The available categories are: ${categoryListString}
    If multiple categories match, include multiple category IDs. If no categories match, return an empty array.
  `
    : "";

  // Change the system prompt company for your use case
  const systemPrompt = `You are acting as an technical training assistant for a company called Trainnect. You are inside a chat window on a website. You are chatting with a human user who is asking for help about Trainnect's technical training course related products and services. When responding to the user, aim to provide concise and helpful responses while maintaining a polite and professional tone.

  To help you answer the user's question, we have retrieved the following information for you. It may or may not be relevant (we are using a RAG pipeline to retrieve this information):
  ${isRagWorking ? `${retrievedContext}` : "No information found for this query."}

  Please provide responses that only use the information you have been given. If no information is available or if the information is not relevant for answering the question, you can redirect the user to a human agent for further assistance.

  ${categoriesContext}

  If the question is unrelated to Trainnect's technical training course related products and services, you should redirect the user to a human agent.

  You are the first point of contact for the user and should try to resolve their issue or provide relevant information. If you are unable to help the user or if the user explicitly asks to talk to a human, you can redirect them to a human agent for further assistance.
  
  To display your responses correctly, you must format your entire response as a valid JSON object with the following structure:
  {
      "thinking": "Brief explanation of your reasoning for how you should address the user's query",
      "response": "Your concise response to the user",
      "user_mood": "positive|neutral|negative|curious|frustrated|confused",
      "suggested_questions": ["Question 1?", "Question 2?", "Question 3?"],
      "debug": {
        "context_used": true|false
      },
      ${USE_CATEGORIES ? '"matched_categories": ["category_id1", "category_id2"],' : ""}
      "redirect_to_agent": {
        "should_redirect": boolean,
        "reason": "Reason for redirection (optional, include only if should_redirect is true)"
      }
    }

  Here are a few examples of how your response should look like:

  Example of a response without redirection to a human agent:
  {
    "thinking": "Providing relevant information from the knowledge base",
    "response": "Here's the information you requested...",
    "user_mood": "curious",
    "suggested_questions": ["What is the course schedule?", "What is the course curriculum?"],
    "debug": {
      "context_used": true
    },
    "matched_categories": ["courses", "technical"],
    "redirect_to_agent": {
      "should_redirect": false
    }
  }

  Example of a response with redirection to a human agent:
  {
    "thinking": "User request requires human intervention",
    "response": "I understand this is a complex issue. Let me connect you with a human agent who can assist you better.",
    "user_mood": "frustrated",
    "suggested_questions": [],
    "debug": {
      "context_used": false
    },
    "matched_categories": ["technical_support"],
    "redirect_to_agent": {
      "should_redirect": true,
      "reason": "Complex technical issue requiring human expertise"
    }
  }
  `

  function sanitizeAndParseJSON(jsonString: string) {
    // Replace newlines within string values
    const sanitized = jsonString.replace(/(?<=:\s*")(.|\n)*?(?=")/g, (match) =>
      match.replace(/\n/g, "\\n")
    );

    try {
      return JSON.parse(sanitized);
    } catch (parseError) {
      console.error("Error parsing JSON response:", parseError);
      throw new Error("Invalid JSON response from AI");
    }
  }

  try {
    console.log(`🚀 Query Processing`);
    measureTime("Claude Generation Start");

    const anthropicMessages = messages.map((msg: any) => ({
      role: msg.role,
      content: msg.content,
    }));

    const stream = await anthropic.messages.stream({
      messages: anthropicMessages,
      model: model,
      max_tokens: 1000,
      system: systemPrompt,
      temperature: 0.3,
    });

    // Create a TransformStream for streaming
    const encoder = new TextEncoder();
    const transformStream = new TransformStream({
      async transform(chunk: string, controller) {
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
      },
    });

    const streamResponse = new Response(transformStream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });

    // Add RAG sources and debug data to headers
    if (ragSources.length > 0) {
      streamResponse.headers.set(
        "x-rag-sources",
        sanitizeHeaderValue(JSON.stringify(ragSources))
      );
    }
    streamResponse.headers.set("X-Debug-Data", sanitizeHeaderValue(debugData));

    // Process the stream
    (async () => {
      const writer = transformStream.writable.getWriter();
      try {
        let accumulatedResponse = {
          thinking: "",
          response: "",
          user_mood: "neutral" as const,
          suggested_questions: [] as string[],
          debug: { context_used: isRagWorking },
          matched_categories: [] as string[],
          redirect_to_agent: { should_redirect: false },
        };

        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const text = event.delta.text;
            try {
              // Try to accumulate and parse JSON
              const combinedText = accumulatedResponse.response + text;
              if (combinedText.includes("{") && combinedText.includes("}")) {
                const jsonStr = combinedText.substring(
                  combinedText.indexOf("{"),
                  combinedText.lastIndexOf("}") + 1
                );
                try {
                  const parsed = sanitizeAndParseJSON(jsonStr);
                  if (parsed && typeof parsed === "object") {
                    accumulatedResponse = {
                      ...accumulatedResponse,
                      ...parsed,
                      user_mood: parsed.user_mood || accumulatedResponse.user_mood,
                      suggested_questions:
                        parsed.suggested_questions ||
                        accumulatedResponse.suggested_questions,
                      matched_categories:
                        parsed.matched_categories ||
                        accumulatedResponse.matched_categories,
                    };
                  }
                } catch (e) {
                  // Ignore parsing errors for incomplete JSON
                }
              }
            } catch (e) {
              // Ignore parsing errors during streaming
            }

            await writer.write(JSON.stringify({
              chunk: text,
              ...accumulatedResponse,
            }));
          }
        }

        // Get and validate final message
        const finalMessage = await stream.finalMessage();
        const textContent = finalMessage.content
          .filter((block: { type: string }) => block.type === "text")
          .map((block: { text: string }) => block.text)
          .join(" ");

        let finalResponse = sanitizeAndParseJSON(textContent);
        finalResponse = responseSchema.parse(finalResponse);
        finalResponse.id = crypto.randomUUID();

        // Send final validated response
        await writer.write(JSON.stringify({
          done: true,
          ...finalResponse,
        }));

        measureTime("Claude Generation Complete");
        console.log("✅ Message generation completed");
      } catch (error) {
        console.error("Error in streaming:", error);
        const errorResponse = {
          response: "Sorry, there was an issue processing your request. Please try again later.",
          thinking: "Error occurred during message generation.",
          user_mood: "neutral" as const,
          debug: { context_used: false },
        };
        await writer.write(JSON.stringify({
          error: true,
          ...errorResponse,
        }));
      } finally {
        await writer.close();
      }
    })();

    return streamResponse;
  } catch (error) {
    // Handle errors in AI response generation
    console.error("💥 Error in message generation:", error);
    const errorResponse = {
      response:
        "Sorry, there was an issue processing your request. Please try again later.",
      thinking: "Error occurred during message generation.",
      user_mood: "neutral",
      debug: { context_used: false },
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}